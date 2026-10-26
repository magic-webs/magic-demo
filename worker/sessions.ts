import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
import { hostMatchesAllowlist, isPrivateAddress, matchesTrustedPrefix } from "../lib/browser/url-safety";
import { startEgressProxy } from "./egress-proxy";

export type WorkerSession = {
  id: string;
  proc: ChildProcess;
  userDataDir: string;
  /** Local Chrome DevTools endpoint. Never leaves the worker. */
  wsEndpoint: string;
  browser: Browser;
  context: BrowserContext;
  allowlist: string[];
  trusted: string[];
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
  targetIds: WeakMap<Page, string>;
  closeProxy: () => Promise<void>;
};

const sessions = new Map<string, WorkerSession>();

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

export function resolveChrome(): string {
  const fromEnv = process.env.BROWSER_EXECUTABLE_PATH;
  if (fromEnv) return fromEnv;
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // Playwright browsers not installed
  }
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error("No Chrome/Chromium found. Set BROWSER_EXECUTABLE_PATH or run `npx playwright-core install chromium`.");
  }
  return found;
}

// ---------------- network guard ----------------

const dnsCache = new Map<string, { privateAddr: boolean; at: number }>();
const BLOCKED_NAMES = /^(localhost|metadata|metadata\.google\.internal|instance-data)$|\.(localhost|local|internal|lan|home|corp|intranet)$/i;

async function isBlockedHost(host: string): Promise<boolean> {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_NAMES.test(h)) return true;
  if (isIP(h)) return isPrivateAddress(h);
  const cached = dnsCache.get(h);
  if (cached && Date.now() - cached.at < 60_000) return cached.privateAddr;
  let privateAddr = true;
  try {
    const addrs = await lookup(h, { all: true });
    privateAddr = addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address));
  } catch {
    privateAddr = true;
  }
  dnsCache.set(h, { privateAddr, at: Date.now() });
  return privateAddr;
}

/**
 * Second layer (the egress proxy is the first and the one that sees redirects):
 * blocks private targets early with a clear error, and enforces the domain
 * allowlist for top-level navigations.
 */
function makeGuard(session: () => WorkerSession) {
  return async (route: Route) => {
    const req = route.request();
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      return route.abort("blockedbyclient");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return route.continue();
    const s = session();
    if (matchesTrustedPrefix(url, s.trusted)) return route.continue();
    if (url.port && url.port !== "80" && url.port !== "443") return route.abort("blockedbyclient");
    if (await isBlockedHost(url.hostname)) return route.abort("blockedbyclient");
    let isMainFrameNav = false;
    try {
      isMainFrameNav = req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame();
    } catch {
      isMainFrameNav = false;
    }
    if (isMainFrameNav && !hostMatchesAllowlist(url.hostname, s.allowlist)) return route.abort("blockedbyclient");
    return route.continue();
  };
}

// ---------------- lifecycle ----------------

function waitForDevtools(proc: ChildProcess, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not start in time")), timeoutMs);
    proc.stderr?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (code ${code})`));
    });
  });
}

export async function createSession(opts: { allowlist: string[]; trusted: string[]; timeoutSec: number; maxSessions: number }) {
  if (sessions.size >= opts.maxSessions) {
    throw Object.assign(new Error("Worker is at its session limit. Try again later."), { status: 503 });
  }
  const id = randomUUID();
  const userDataDir = await mkdtemp(join(tmpdir(), "magic-browser-"));
  const proxy = await startEgressProxy(opts.trusted);
  const args = [
    // All traffic (incl. localhost, which Chrome normally bypasses) goes through the egress proxy.
    `--proxy-server=http://127.0.0.1:${proxy.port}`,
    "--proxy-bypass-list=<-loopback>",
    // No DNS prefetch or QUIC side channels around the proxy.
    "--dns-prefetch-disable",
    "--disable-quic",
    "--headless=new",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1280,800",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--mute-audio",
    "--password-store=basic",
    ...(process.env.WORKER_NO_SANDBOX === "true" ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  const proc = spawn(resolveChrome(), args, { stdio: ["ignore", "ignore", "pipe"] });
  // Keep the last few stderr lines for crash diagnostics.
  const stderrTail: string[] = [];
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrTail.push(chunk.toString());
    if (stderrTail.length > 20) stderrTail.shift();
  });
  try {
    const wsEndpoint = await waitForDevtools(proc);
    const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 15_000 });
    const context = browser.contexts()[0];
    const now = Date.now();
    const session: WorkerSession = {
      id,
      proc,
      userDataDir,
      wsEndpoint,
      browser,
      context,
      allowlist: opts.allowlist,
      trusted: opts.trusted,
      createdAt: now,
      lastActivity: now,
      expiresAt: now + opts.timeoutSec * 1000,
      targetIds: new WeakMap(),
      closeProxy: proxy.close,
    };
    await context.route("**/*", makeGuard(() => session));
    sessions.set(id, session);
    proc.once("exit", (code, signal) => {
      if (sessions.get(id) !== session) return;
      console.warn(`[worker] Chrome for session ${id.slice(0, 8)} exited unexpectedly (code ${code}, signal ${signal}). Last output:\n${stderrTail.join("")}`);
      void releaseSession(id);
    });
    return session;
  } catch (err) {
    proc.kill("SIGKILL");
    await proxy.close().catch(() => {});
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export function getSession(id: string) {
  return sessions.get(id) ?? null;
}

export function touch(session: WorkerSession) {
  session.lastActivity = Date.now();
}

export async function releaseSession(id: string) {
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  await s.browser.close().catch(() => {});
  s.proc.kill("SIGKILL");
  await s.closeProxy().catch(() => {});
  await rm(s.userDataDir, { recursive: true, force: true }).catch(() => {});
  return true;
}

export async function targetIdOf(s: WorkerSession, page: Page) {
  const known = s.targetIds.get(page);
  if (known) return known;
  const cdp = await s.context.newCDPSession(page);
  try {
    const { targetInfo } = (await cdp.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
    s.targetIds.set(page, targetInfo.targetId);
    return targetInfo.targetId;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export async function listPages(s: WorkerSession) {
  const out = [];
  for (const page of s.context.pages()) {
    if (page.isClosed()) continue;
    out.push({ id: await targetIdOf(s, page), url: page.url(), title: await page.title().catch(() => "") });
  }
  return out;
}

export async function findPage(s: WorkerSession, targetId: string) {
  for (const page of s.context.pages()) {
    if (!page.isClosed() && (await targetIdOf(s, page)) === targetId) return page;
  }
  return null;
}

/** Idle and hard-timeout cleanup. */
export function startReaper(idleMs: number) {
  return setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (now > s.expiresAt || now - s.lastActivity > idleMs) {
        console.log(`[worker] releasing session ${s.id.slice(0, 8)}: ${now > s.expiresAt ? "hard timeout" : "idle timeout"}`);
        void releaseSession(s.id);
      }
    }
  }, 15_000);
}

export async function releaseAll() {
  await Promise.all([...sessions.keys()].map((id) => releaseSession(id)));
}

export function sessionCount() {
  return sessions.size;
}
