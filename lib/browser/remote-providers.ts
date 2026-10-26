import "server-only";
import Browserbase from "@browserbasehq/sdk";
import type { ServerConfig } from "@/lib/server-config";
import { CdpAdapter, connectCdp, dropConnection, VIEWPORT, type RemoteKind } from "./cdp-adapter";
import { signLiveToken } from "./live-token";
import { BrowserActionError } from "./types";

export type LivePage = { tabId: string; kind: "iframe" | "stream"; liveUrl: string | null };

export interface RemoteProvider {
  kind: RemoteKind;
  create(allowlist: string[], trusted: string[]): Promise<{ providerSessionId: string }>;
  release(providerSessionId: string): Promise<void>;
  connect(providerSessionId: string, opts: { allowlist: string[]; trusted: string[]; activeTabId?: string }): Promise<CdpAdapter>;
  /** Short-lived, per-tab viewer URLs. Treat as secrets: they grant viewing (and maybe control). */
  liveView(providerSessionId: string, tabs: Array<{ tabId: string; url: string }>, opts: { interactive: boolean }): Promise<LivePage[]>;
}

export function getProvider(config: ServerConfig, kind: RemoteKind): RemoteProvider {
  return kind === "selfhosted" ? selfHosted(config) : browserbase(config);
}

// ---------------------------------------------------------------------------
// Self-hosted worker (worker/index.ts): our own Chromium per session.
// ---------------------------------------------------------------------------

function selfHosted(config: ServerConfig): RemoteProvider {
  const { url: base, publicUrl, secret } = config.worker;
  const auth = { Authorization: `Bearer ${secret}` };
  const call = async (path: string, init: RequestInit = {}) => {
    try {
      return await fetch(`${base}${path}`, { ...init, headers: { ...auth, "Content-Type": "application/json", ...init.headers }, cache: "no-store" });
    } catch {
      throw new BrowserActionError("PROVIDER_ERROR", "The browser worker isn't reachable. Is `bun run worker` running?", false);
    }
  };
  const resolve = (id: string) => async () => {
    const res = await call(`/sessions/${id}`);
    if (res.status === 404) throw new BrowserActionError("SESSION_EXPIRED", "The browser session has ended.", false);
    if (!res.ok) throw new BrowserActionError("PROVIDER_ERROR", `Worker error ${res.status}`);
    return { url: `${base.replace(/^http/, "ws")}/cdp/${id}`, headers: auth };
  };

  return {
    kind: "selfhosted",
    async create(allowlist, trusted) {
      const res = await call("/sessions", {
        method: "POST",
        body: JSON.stringify({ allowedDomains: allowlist, trustedPrefixes: trusted, timeoutSec: config.sessionTimeoutSec }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? `Worker returned ${res.status}`);
      await connectCdp(`selfhosted:${body.id}`, resolve(body.id));
      return { providerSessionId: body.id };
    },
    async release(id) {
      dropConnection(`selfhosted:${id}`);
      await call(`/sessions/${id}`, { method: "DELETE" });
    },
    connect(id, opts) {
      return CdpAdapter.connect({ provider: "selfhosted", providerSessionId: id, resolve: resolve(id), ...opts });
    },
    async liveView(id, tabs, opts) {
      const wsBase = publicUrl.replace(/^http/, "ws");
      const exp = Date.now() + 10 * 60 * 1000;
      return tabs.map((t) => ({
        tabId: t.tabId,
        kind: "stream" as const,
        liveUrl: `${wsBase}/live/${id}?token=${encodeURIComponent(signLiveToken({ sid: id, tab: t.tabId, input: opts.interactive, exp }, secret))}`,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Browserbase (optional hosted provider).
// ---------------------------------------------------------------------------

function browserbase(config: ServerConfig): RemoteProvider {
  const client = () => new Browserbase({ apiKey: config.browserbase.apiKey });
  const resolve = (id: string, connectUrl?: string) => async () => {
    if (connectUrl) return { url: connectUrl };
    const session = await client().sessions.retrieve(id);
    if (session.status !== "RUNNING" || !session.connectUrl) {
      throw new BrowserActionError("SESSION_EXPIRED", `Remote browser session is ${session.status.toLowerCase()}.`, false);
    }
    return { url: session.connectUrl };
  };

  return {
    kind: "browserbase",
    async create(allowlist) {
      const session = await client().sessions.create({
        projectId: config.browserbase.projectId,
        keepAlive: config.browserbase.keepAlive,
        api_timeout: config.sessionTimeoutSec,
        region: config.browserbase.region,
        browserSettings: {
          viewport: VIEWPORT,
          blockAds: true,
          // Provider-side enforcement of top-level navigations (catches redirects).
          ...(allowlist.includes("*") ? {} : { allowedDomains: allowlist }),
        },
        userMetadata: { app: "magic-browser-assistant" },
      });
      const browser = await connectCdp(`browserbase:${session.id}`, resolve(session.id, session.connectUrl));
      const context = browser.contexts()[0] ?? (await browser.newContext());
      if (context.pages().length === 0) await context.newPage();
      return { providerSessionId: session.id };
    },
    async release(id) {
      dropConnection(`browserbase:${id}`);
      await client().sessions.update(id, { status: "REQUEST_RELEASE", projectId: config.browserbase.projectId });
    },
    connect(id, opts) {
      return CdpAdapter.connect({ provider: "browserbase", providerSessionId: id, resolve: resolve(id), ...opts });
    },
    async liveView(id, tabs) {
      const live = await client().sessions.debug(id, { expiresIn: 900 });
      const pages = live.pages.map((p) => ({
        id: p.id,
        url: p.url,
        liveUrl: `${p.debuggerFullscreenUrl}${p.debuggerFullscreenUrl.includes("?") ? "&" : "?"}navbar=false`,
      }));
      // Map provider pages to our tab ids (CDP target ids); fall back to URL, then order.
      const used = new Set<string>();
      return tabs.map((tab, i) => {
        const match =
          pages.find((p) => p.id === tab.tabId) ??
          pages.find((p) => !used.has(p.id) && p.url === tab.url) ??
          pages.filter((p) => !used.has(p.id))[0] ??
          pages[i];
        if (match) used.add(match.id);
        return { tabId: tab.tabId, kind: "iframe" as const, liveUrl: match?.liveUrl ?? null };
      });
    },
  };
}
