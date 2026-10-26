import "server-only";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import {
  BrowserActionError,
  type BrowserAdapter,
  type ElementInfo,
  type Observation,
  type PageState,
  type ScrollResult,
  type TabInfo,
} from "./types";
import { INSTALL_CURSOR_SCRIPT, MOVE_CURSOR_SCRIPT, OBSERVE_SCRIPT, SCROLL_STATE_SCRIPT } from "./page-scripts";
import { checkNavigationUrl, isReachedUrlAllowed } from "./url-safety";

export type RemoteKind = "browserbase" | "selfhosted";
export type CdpTarget = { url: string; headers?: Record<string, string> };

export const VIEWPORT = { width: 1280, height: 800 };
const MAX_ELEMENTS = 80;
const MAX_TEXT = 3500;

// Connection cache. Purely an optimisation for long-lived Node processes
// (e.g. `next dev`): ownership and session state live in Convex, and a cache
// miss simply reconnects over CDP.
const globalCache = globalThis as unknown as { __cdpConnections?: Map<string, Promise<Browser>> };
const connections = (globalCache.__cdpConnections ??= new Map<string, Promise<Browser>>());

export async function connectCdp(key: string, resolve: () => Promise<CdpTarget>): Promise<Browser> {
  const cached = connections.get(key);
  if (cached) {
    try {
      const browser = await cached;
      if (browser.isConnected()) return browser;
    } catch {
      // fall through and reconnect
    }
    connections.delete(key);
  }
  const pending = (async () => {
    const target = await resolve();
    const browser = await chromium.connectOverCDP(target.url, { timeout: 20_000, headers: target.headers });
    browser.on("disconnected", () => connections.delete(key));
    return browser;
  })();
  connections.set(key, pending);
  try {
    return await pending;
  } catch (err) {
    connections.delete(key);
    throw err;
  }
}

export function dropConnection(key: string) {
  const cached = connections.get(key);
  connections.delete(key);
  cached?.then((b) => b.close().catch(() => {})).catch(() => {});
}

/** Generic Playwright-over-CDP adapter used by every remote provider. */
const globalCursor = globalThis as unknown as { __cursorPositions?: Map<string, { x: number; y: number }> };
const cursorPositions = (globalCursor.__cursorPositions ??= new Map());

export class CdpAdapter implements BrowserAdapter {
  /** Show the animated assistant cursor (user setting). */
  cursorEnabled = true;
  private refs = new Map<string, { info: ElementInfo; tabId: string; url: string }>();
  private targetIds = new WeakMap<Page, string>();
  private active: string | undefined;

  private constructor(
    readonly provider: RemoteKind,
    private context: BrowserContext,
    private allowlist: string[],
    private trusted: string[],
    activeTabId: string | undefined,
  ) {
    this.active = activeTabId;
  }

  static async connect(opts: {
    provider: RemoteKind;
    providerSessionId: string;
    resolve: () => Promise<CdpTarget>;
    allowlist: string[];
    trusted: string[];
    activeTabId?: string;
  }) {
    const browser = await connectCdp(`${opts.provider}:${opts.providerSessionId}`, opts.resolve);
    const context = browser.contexts()[0];
    if (!context) throw new BrowserActionError("SESSION_EXPIRED", "Remote browser has no context.", false);
    const adapter = new CdpAdapter(opts.provider, context, opts.allowlist, opts.trusted, opts.activeTabId);
    await adapter.resolveActive();
    return adapter;
  }

  private async tabIdOf(page: Page) {
    const known = this.targetIds.get(page);
    if (known) return known;
    const cdp = await this.context.newCDPSession(page);
    try {
      const { targetInfo } = (await cdp.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
      this.targetIds.set(page, targetInfo.targetId);
      return targetInfo.targetId;
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  private pages() {
    return this.context.pages().filter((p) => !p.isClosed());
  }

  private async resolveActive(): Promise<Page> {
    const pages = this.pages();
    if (pages.length === 0) {
      const page = await this.context.newPage();
      this.active = await this.tabIdOf(page);
      return page;
    }
    for (const page of pages) {
      if ((await this.tabIdOf(page)) === this.active) return page;
    }
    const page = pages[pages.length - 1];
    this.active = await this.tabIdOf(page);
    return page;
  }

  private async page() {
    return this.resolveActive();
  }

  activeTabId() {
    return this.active;
  }

  async listTabs(): Promise<TabInfo[]> {
    const tabs: TabInfo[] = [];
    for (const page of this.pages()) {
      tabs.push({
        tabId: await this.tabIdOf(page),
        title: (await page.title().catch(() => "")) || "New tab",
        url: page.url(),
      });
    }
    return tabs;
  }

  private async state(page: Page): Promise<PageState> {
    return { tabId: await this.tabIdOf(page), title: (await page.title().catch(() => "")) || "Untitled", url: page.url() };
  }

  private async settle(page: Page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(400);
    // Redirect revalidation: the remote browser enforces allowedDomains, and we
    // double-check where every tab ended up.
    for (const p of this.pages()) {
      if (!isReachedUrlAllowed(p.url(), this.allowlist, this.trusted)) {
        const blocked = p.url();
        await p.goto("about:blank").catch(() => {});
        if (p === page) {
          throw new BrowserActionError("NAVIGATION_BLOCKED", `Navigation to ${new URL(blocked).host} was blocked (not allowed).`);
        }
      }
    }
  }

  async observe(): Promise<Observation> {
    const page = await this.page();
    const prefix = `o${Math.random().toString(36).slice(2, 6)}`;
    const snap = (await page.evaluate(`(${OBSERVE_SCRIPT})(${JSON.stringify({ prefix, maxElements: MAX_ELEMENTS, maxText: MAX_TEXT })})`)) as Omit<Observation, "observationId" | "tabId">;
    const tabId = await this.tabIdOf(page);
    // Only refs from the newest observation are valid.
    this.refs.clear();
    for (const el of snap.elements) this.refs.set(el.ref, { info: el, tabId, url: snap.url });
    return { observationId: prefix, tabId, ...snap };
  }

  describeRef(ref: string) {
    return this.refs.get(ref)?.info ?? null;
  }

  private async locate(ref: string) {
    const entry = this.refs.get(ref);
    if (!entry) {
      throw new BrowserActionError("STALE_REF", `Element ref "${ref}" is unknown or stale. Call observePage and use a fresh ref.`);
    }
    const page = await this.page();
    if ((await this.tabIdOf(page)) !== entry.tabId || page.url() !== entry.url) {
      this.refs.clear();
      throw new BrowserActionError("STALE_REF", "The page changed since the last observation. Call observePage again.");
    }
    const locator = page.locator(`[data-agent-ref="${ref}"]`);
    if ((await locator.count()) !== 1) {
      throw new BrowserActionError("STALE_REF", "That element is no longer on the page. Call observePage again.");
    }
    return { page, locator, info: entry.info };
  }

  /** Last cursor position per tab, so the cursor continues from where it was (even across pages). */
  private cursorPos(tabId: string) {
    return cursorPositions.get(tabId) ?? { x: VIEWPORT.width * 0.62, y: VIEWPORT.height * 0.55 };
  }

  /**
   * One animated cursor step inside the page (cosmetic only). Moves along a
   * curve to the target, optionally highlights the element and plays a press.
   */
  private async cursorStep(
    page: Page,
    step: { box?: { x: number; y: number; width: number; height: number } | null; x?: number; y?: number; label: string; press?: boolean },
  ) {
    if (!this.cursorEnabled) return;
    try {
      const tabId = await this.tabIdOf(page);
      await page.evaluate(`(${INSTALL_CURSOR_SCRIPT})(${JSON.stringify(this.cursorPos(tabId))})`);
      const x = step.box ? step.box.x + Math.min(step.box.width / 2, 24) : (step.x ?? VIEWPORT.width / 2);
      const y = step.box ? step.box.y + step.box.height / 2 : (step.y ?? VIEWPORT.height / 2);
      const pos = (await page.evaluate(
        `(${MOVE_CURSOR_SCRIPT})(${JSON.stringify({ x, y, box: step.box ?? null, label: step.label, press: step.press ?? false })})`,
      )) as { x: number; y: number } | null;
      if (pos) cursorPositions.set(tabId, pos);
    } catch {
      // The overlay is cosmetic; never fail the real action because of it.
    }
  }

  /** After a navigation the overlay is gone with the old document; bring it back where it was. */
  private async restoreCursor(page: Page) {
    if (!this.cursorEnabled) return;
    try {
      const tabId = await this.tabIdOf(page);
      await page.evaluate(`(${INSTALL_CURSOR_SCRIPT})(${JSON.stringify(this.cursorPos(tabId))})`);
      await page.evaluate("window.__agentCursor && window.__agentCursor.label('Assistant')");
    } catch {
      // cosmetic
    }
  }

  async openUrl(url: string) {
    const check = await checkNavigationUrl(url, this.allowlist, { trusted: this.trusted });
    if (!check.ok) throw new BrowserActionError(check.code === "NOT_ALLOWED" ? "NAVIGATION_BLOCKED" : "INVALID_URL", check.message);
    const page = await this.page();
    try {
      await page.goto(check.url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    } catch (err) {
      if (err instanceof Error && /timeout/i.test(err.message)) {
        throw new BrowserActionError("TIMEOUT", "The page took too long to load.");
      }
      throw new BrowserActionError("PROVIDER_ERROR", `Navigation failed: ${err instanceof Error ? err.message.split("\n")[0] : "unknown"}`);
    }
    this.refs.clear();
    await this.settle(page);
    await this.restoreCursor(page);
    return this.state(page);
  }

  async click(ref: string, opts: { showCursor: boolean }) {
    const { page, locator } = await this.locate(ref);
    await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    if (opts.showCursor) await this.cursorStep(page, { box: await locator.boundingBox(), label: "Clicking", press: true });
    const popup = this.context.waitForEvent("page", { timeout: 2_500 }).catch(() => null);
    try {
      await locator.click({ timeout: 8_000 });
    } catch (err) {
      throw new BrowserActionError("TIMEOUT", `Click failed: ${err instanceof Error ? err.message.split("\n")[0] : "unknown"}`);
    }
    this.refs.clear();
    const opened = await popup;
    if (opened && this.pages().length > 0) {
      await opened.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      this.active = await this.tabIdOf(opened);
      await opened.bringToFront().catch(() => {});
      await this.settle(opened);
      await this.restoreCursor(opened);
      return { ...(await this.state(opened)), openedTab: true };
    }
    await this.settle(page);
    await this.restoreCursor(page);
    return this.state(page);
  }

  async fill(ref: string, text: string, opts: { submit: boolean; showCursor: boolean }) {
    const { page, locator, info } = await this.locate(ref);
    if (info.inputType === "password") {
      throw new BrowserActionError("PASSWORD_FIELD", "I never type passwords. Use “Take control” to sign in yourself.");
    }
    await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    if (opts.showCursor) await this.cursorStep(page, { box: await locator.boundingBox(), label: "Typing…", press: true });
    try {
      await locator.fill(text, { timeout: 8_000 });
      if (opts.submit) await locator.press("Enter");
    } catch (err) {
      throw new BrowserActionError("TIMEOUT", `Typing failed: ${err instanceof Error ? err.message.split("\n")[0] : "unknown"}`);
    }
    if (opts.submit) {
      this.refs.clear();
      await this.settle(page);
      await this.restoreCursor(page);
    }
    return this.state(page);
  }

  async scroll(direction: "up" | "down", amount: "small" | "page" | "top" | "bottom"): Promise<ScrollResult> {
    const page = await this.page();
    const before = (await page.evaluate(`(${SCROLL_STATE_SCRIPT})()`)) as { y: number; maxY: number };
    const vh = page.viewportSize()?.height ?? VIEWPORT.height;
    const distance =
      amount === "top" ? -before.y - 10 : amount === "bottom" ? before.maxY - before.y + 10 : (amount === "small" ? 300 : Math.round(vh * 0.8)) * (direction === "down" ? 1 : -1);
    const vw = page.viewportSize()?.width ?? VIEWPORT.width;
    await this.cursorStep(page, { x: vw * 0.62, y: vh * 0.55, label: distance > 0 ? "Scrolling ↓" : "Scrolling ↑" });
    await page.mouse.move(vw / 2, vh / 2);
    // Real wheel input, in steps so it looks natural in the live view.
    const steps = Math.min(8, Math.max(1, Math.ceil(Math.abs(distance) / 250)));
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, distance / steps);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(350);
    const after = (await page.evaluate(`(${SCROLL_STATE_SCRIPT})()`)) as { y: number; maxY: number };
    await this.cursorStep(page, { x: vw * 0.62, y: vh * 0.55, label: "Assistant" });
    this.refs.clear();
    return { ...(await this.state(page)), before: before.y, after: after.y, maxY: after.maxY };
  }

  async goBack() {
    const page = await this.page();
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
    this.refs.clear();
    await this.settle(page);
    await this.restoreCursor(page);
    return this.state(page);
  }

  async goForward() {
    const page = await this.page();
    await page.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
    this.refs.clear();
    await this.settle(page);
    await this.restoreCursor(page);
    return this.state(page);
  }

  async openTab(url: string | null) {
    let target: string | null = null;
    if (url) {
      const check = await checkNavigationUrl(url, this.allowlist, { trusted: this.trusted });
      if (!check.ok) throw new BrowserActionError(check.code === "NOT_ALLOWED" ? "NAVIGATION_BLOCKED" : "INVALID_URL", check.message);
      target = check.url;
    }
    const page = await this.context.newPage();
    this.active = await this.tabIdOf(page);
    this.refs.clear();
    if (target) {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {
        throw new BrowserActionError("TIMEOUT", "The new tab took too long to load.");
      });
      await this.settle(page);
    }
    return this.state(page);
  }

  async switchTab(tabId: string) {
    for (const page of this.pages()) {
      if ((await this.tabIdOf(page)) === tabId) {
        await page.bringToFront().catch(() => {});
        this.active = tabId;
        this.refs.clear();
        return this.state(page);
      }
    }
    throw new BrowserActionError("TAB_NOT_FOUND", "No tab with that id. Call listTabs.");
  }

  async closeTab(tabId: string) {
    const pages = this.pages();
    for (const page of pages) {
      if ((await this.tabIdOf(page)) === tabId) {
        if (pages.length === 1) {
          throw new BrowserActionError("TAB_LIMIT", "Can't close the last tab. End the session instead.");
        }
        await page.close();
        this.refs.clear();
        if (this.active === tabId) {
          const remaining = this.pages();
          const next = remaining[remaining.length - 1];
          this.active = await this.tabIdOf(next);
          await next.bringToFront().catch(() => {});
        }
        return this.state(await this.page());
      }
    }
    throw new BrowserActionError("TAB_NOT_FOUND", "No tab with that id. Call listTabs.");
  }

  async disconnect() {
    // Keep the cached CDP connection for the next request in long-lived
    // processes. In serverless the process is frozen/discarded, which also
    // drops the socket; keepAlive sessions survive that.
  }
}
