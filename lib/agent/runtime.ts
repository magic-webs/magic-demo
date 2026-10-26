import "server-only";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ServerConfig } from "@/lib/server-config";
import { convexErrorMessage, type ConvexAs } from "@/lib/convex-server";
import { getProvider } from "@/lib/browser/remote-providers";
import { DemoAdapter } from "@/lib/browser/demo-adapter";
import { BrowserActionError, type BrowserAdapter, type PageState } from "@/lib/browser/types";

export type ActionResult = {
  ok: boolean;
  summary: string;
  page?: PageState;
  error?: { code: string; message: string; recoverable: boolean };
  approvalId?: string;
  [key: string]: unknown;
};

type ActionMeta = {
  tool: string;
  label: string;
  readOnly: boolean;
  idempotencyKey: string;
  /** If true and no session exists, one is created first. */
  createSession?: boolean;
};

/**
 * Per-request runtime: binds the user's Convex identity, one conversation, an
 * optional agent run, and the browser adapter. Durable state lives in Convex.
 */
export class AgentRuntime {
  sessionId: Id<"browserSessions"> | null = null;
  private adapter: BrowserAdapter | null = null;
  private allowlist: string[] = [];
  showCursor = true;

  constructor(
    readonly convex: ConvexAs,
    readonly config: ServerConfig,
    readonly conversationId: Id<"conversations">,
    readonly runId: Id<"agentRuns"> | null,
  ) {}

  async init() {
    const [current, settings] = await Promise.all([
      this.convex.query(api.browserSessions.getForConversation, { conversationId: this.conversationId }),
      this.convex.query(api.browserSessions.getSettings, {}),
    ]);
    this.showCursor = settings.showCursor;
    this.allowlist = Array.from(new Set([...this.config.allowedDomains, ...settings.extraAllowedDomains]));
    if (current && ["starting", "running", "reconnecting"].includes(current.session.status)) {
      this.sessionId = current.session._id;
      this.allowlist = current.session.allowedDomains;
    }
    return this;
  }

  get provider() {
    return this.config.browserMode;
  }

  /** Create a new remote (or demo) browser session for this conversation. */
  async createSession(): Promise<{ created: boolean }> {
    if (this.sessionId) return { created: false };
    const { sessionId, existing } = await this.convex.mutation(api.browserSessions.createPending, {
      conversationId: this.conversationId,
      provider: this.config.browserMode,
      allowedDomains: this.allowlist,
      timeoutSec: this.config.sessionTimeoutSec,
    });
    this.sessionId = sessionId;
    if (this.runId) await this.convex.mutation(api.agentRuns.attachSession, { runId: this.runId, sessionId });
    if (existing) return { created: false };
    try {
      if (this.config.browserMode !== "demo") {
        const provider = getProvider(this.config, this.config.browserMode);
        const { providerSessionId } = await provider.create(this.allowlist, this.config.trustedPrefixes);
        await this.convex.mutation(api.browserSessions.markRunning, { sessionId, providerSessionId });
      } else {
        await this.convex.mutation(api.browserSessions.markRunning, { sessionId, providerSessionId: "demo" });
      }
      await this.syncTabs();
      return { created: true };
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] : "Could not start the browser.";
      await this.convex.mutation(api.browserSessions.markEnded, {
        sessionId,
        status: "error",
        reason: "Failed to start",
        errorMessage: message.slice(0, 300),
      });
      this.sessionId = null;
      throw new BrowserActionError("PROVIDER_ERROR", `Could not start the remote browser: ${message}`, false);
    }
  }

  async endSession(reason = "Ended by user") {
    if (!this.sessionId) return;
    const view = await this.convex.query(api.browserSessions.getInternalView, { sessionId: this.sessionId });
    let releaseError: string | undefined;
    if (view.provider !== "demo" && view.providerSessionId) {
      try {
        await getProvider(this.config, view.provider).release(view.providerSessionId);
      } catch (err) {
        releaseError = err instanceof Error ? err.message.split("\n")[0] : "release failed";
      }
    }
    await this.convex.mutation(api.browserSessions.markEnded, {
      sessionId: this.sessionId,
      status: "ended",
      reason,
      errorMessage: releaseError ? `Provider release failed (it will time out): ${releaseError}` : undefined,
    });
    this.sessionId = null;
    this.adapter = null;
  }

  async getAdapter(): Promise<BrowserAdapter> {
    if (this.adapter) return this.adapter;
    if (!this.sessionId) {
      throw new BrowserActionError("NO_SESSION", "No browser session is running. Call createBrowserSession or openUrl first.");
    }
    const view = await this.convex.query(api.browserSessions.getInternalView, { sessionId: this.sessionId });
    if (view.provider === "demo") {
      this.adapter = new DemoAdapter(view.tabs, view.activeTabId ?? undefined);
      return this.adapter;
    }
    if (!view.providerSessionId) {
      throw new BrowserActionError("NO_SESSION", "The browser session is still starting. Try again in a moment.");
    }
    try {
      const adapter = await getProvider(this.config, view.provider).connect(view.providerSessionId, {
        allowlist: view.allowedDomains,
        trusted: this.config.trustedPrefixes,
        activeTabId: view.activeTabId ?? undefined,
      });
      adapter.cursorEnabled = this.showCursor;
      this.adapter = adapter;
      return adapter;
    } catch (err) {
      // Worker temporarily unreachable: keep the session, let the user retry.
      if (err instanceof BrowserActionError && err.code === "PROVIDER_ERROR") throw err;
      const expired = err instanceof BrowserActionError && err.code === "SESSION_EXPIRED";
      await this.convex.mutation(api.browserSessions.markEnded, {
        sessionId: this.sessionId,
        status: expired ? "expired" : "error",
        reason: expired ? "Remote session ended" : "Reconnect failed",
        errorMessage: err instanceof Error ? err.message.split("\n")[0].slice(0, 300) : undefined,
      });
      this.sessionId = null;
      throw new BrowserActionError(
        "SESSION_EXPIRED",
        "The remote browser session has ended or can't be reconnected. Start a new session to continue.",
        true,
      );
    }
  }

  async syncTabs() {
    if (!this.sessionId) return;
    const adapter = await this.getAdapter();
    const tabs = await adapter.listTabs();
    await this.convex.mutation(api.browserSessions.syncTabs, {
      sessionId: this.sessionId,
      tabs,
      activeTabId: adapter.activeTabId(),
    });
  }

  /**
   * Runs one browser action through the Convex gate (stop/pause/lock/idempotency),
   * executes it, re-syncs real tab state and records the verified outcome.
   */
  async perform(meta: ActionMeta, fn: (adapter: BrowserAdapter, logId: Id<"actionLogs">) => Promise<ActionResult>): Promise<ActionResult> {
    if (meta.createSession && !this.sessionId) {
      try {
        await this.createSession();
      } catch (err) {
        return failure(err);
      }
    }
    let gate;
    try {
      gate = await this.convex.mutation(api.actionLogs.begin, {
        conversationId: this.conversationId,
        runId: this.runId ?? undefined,
        sessionId: this.sessionId ?? undefined,
        idempotencyKey: meta.idempotencyKey,
        tool: meta.tool,
        label: meta.label,
        readOnly: meta.readOnly,
      });
    } catch (err) {
      const e = convexErrorMessage(err);
      return { ok: false, summary: e.message, error: { code: "UNKNOWN", message: e.message, recoverable: false } };
    }
    if (!gate.allowed) {
      const code = gate.reason === "duplicate" ? "DUPLICATE" : gate.reason === "paused" ? "RUN_PAUSED" : gate.reason === "superseded" ? "SUPERSEDED" : "RUN_STOPPED";
      const message =
        gate.reason === "duplicate"
          ? `Already executed: ${gate.previous ?? "same action"}`
          : gate.reason === "paused"
            ? "The user paused the assistant. Stop and tell the user you're paused."
            : gate.reason === "superseded"
              ? "A newer instruction replaced this one. Stop now."
              : "The user stopped this run. Stop now.";
      return { ok: false, summary: message, error: { code, message, recoverable: false } };
    }

    let result: ActionResult;
    try {
      const adapter = await this.getAdapter();
      result = await fn(adapter, gate.logId);
    } catch (err) {
      result = failure(err);
    }
    try {
      if (this.sessionId) await this.syncTabs();
    } catch {
      // Tab sync failure shouldn't hide the action's own outcome.
    }
    const status = result.approvalId ? "awaiting_approval" : result.ok ? "completed" : result.error?.code === "NAVIGATION_BLOCKED" ? "blocked" : "failed";
    await this.convex.mutation(api.actionLogs.complete, {
      logId: gate.logId,
      status,
      summary: result.summary,
      pageTitle: result.page?.title,
      pageUrl: result.page?.url,
      errorCode: result.error?.code,
      approvalId: result.approvalId as Id<"approvals"> | undefined,
    });
    return result;
  }
}

export function failure(err: unknown): ActionResult {
  if (err instanceof BrowserActionError) {
    return { ok: false, summary: err.message, error: { code: err.code, message: err.message, recoverable: err.recoverable } };
  }
  if (err instanceof ConvexError) {
    const e = convexErrorMessage(err);
    return { ok: false, summary: e.message, error: { code: e.code, message: e.message, recoverable: false } };
  }
  const message = err instanceof Error ? err.message.split("\n")[0] : "Unknown error";
  return { ok: false, summary: `Action failed: ${message}`, error: { code: "UNKNOWN", message, recoverable: true } };
}
