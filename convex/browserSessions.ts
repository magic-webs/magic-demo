import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { browserProvider } from "./schema";
import { isLiveStatus, requireConversation, requireSession, requireUserId } from "./lib/access";

const MAX_LIVE_SESSIONS_PER_USER = 1;
const MAX_TABS = 8;

/** Fields that are safe to send to the browser. No provider credentials live here anyway. */
function publicSession(s: Doc<"browserSessions">) {
  return {
    _id: s._id,
    provider: s.provider,
    status: s.status,
    paused: s.paused,
    activeTabId: s.activeTabId ?? null,
    controllingRunId: s.controllingRunId ?? null,
    allowedDomains: s.allowedDomains,
    lastActivityAt: s.lastActivityAt,
    expiresAt: s.expiresAt,
    endReason: s.endReason ?? null,
    errorMessage: s.errorMessage ?? null,
  };
}

/** Latest session for a conversation (live or most recently ended) plus its tabs. */
export const getForConversation = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireConversation(ctx, args.conversationId);
    const latest = await ctx.db
      .query("browserSessions")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .first();
    if (!latest) return null;
    const tabs = await ctx.db
      .query("browserTabs")
      .withIndex("by_sessionId_and_position", (q) => q.eq("sessionId", latest._id))
      .take(MAX_TABS);
    return {
      session: publicSession(latest),
      tabs: tabs.map((t) => ({ tabId: t.tabId, title: t.title, url: t.url, scrollY: t.scrollY ?? 0 })),
    };
  },
});

/** Server-side lookup used by the Next.js routes (still ownership-checked). */
export const getInternalView = query({
  args: { sessionId: v.id("browserSessions") },
  handler: async (ctx, args) => {
    const { session } = await requireSession(ctx, args.sessionId);
    const tabs = await ctx.db
      .query("browserTabs")
      .withIndex("by_sessionId_and_position", (q) => q.eq("sessionId", session._id))
      .take(MAX_TABS);
    return {
      ...publicSession(session),
      conversationId: session.conversationId,
      providerSessionId: session.providerSessionId ?? null,
      tabs: tabs.map((t) => ({ tabId: t.tabId, title: t.title, url: t.url, scrollY: t.scrollY ?? 0 })),
    };
  },
});

export const createPending = mutation({
  args: {
    conversationId: v.id("conversations"),
    provider: browserProvider,
    allowedDomains: v.array(v.string()),
    timeoutSec: v.number(),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireConversation(ctx, args.conversationId);
    const live = [];
    for (const status of ["starting", "running", "reconnecting"] as const) {
      const rows = await ctx.db
        .query("browserSessions")
        .withIndex("by_ownerId_and_status", (q) => q.eq("ownerId", userId).eq("status", status))
        .take(5);
      live.push(...rows);
    }
    const sameConversation = live.find((s) => s.conversationId === args.conversationId);
    if (sameConversation) {
      return { sessionId: sameConversation._id, existing: true };
    }
    if (live.length >= MAX_LIVE_SESSIONS_PER_USER) {
      throw new ConvexError({
        code: "SESSION_LIMIT",
        message: "You already have a live browser session in another conversation. Stop it first.",
      });
    }
    const now = Date.now();
    const sessionId = await ctx.db.insert("browserSessions", {
      ownerId: userId,
      conversationId: args.conversationId,
      provider: args.provider,
      status: "starting",
      paused: false,
      allowedDomains: args.allowedDomains,
      lastActivityAt: now,
      expiresAt: now + args.timeoutSec * 1000,
    });
    return { sessionId, existing: false };
  },
});

export const markRunning = mutation({
  args: { sessionId: v.id("browserSessions"), providerSessionId: v.string() },
  handler: async (ctx, args) => {
    const { session } = await requireSession(ctx, args.sessionId);
    if (!isLiveStatus(session.status)) {
      throw new ConvexError({ code: "SESSION_ENDED", message: "Session already ended." });
    }
    await ctx.db.patch("browserSessions", session._id, {
      providerSessionId: args.providerSessionId,
      status: "running",
      lastActivityAt: Date.now(),
    });
    return null;
  },
});

const tabValidator = v.object({
  tabId: v.string(),
  title: v.string(),
  url: v.string(),
  scrollY: v.optional(v.number()),
});

/** Replace the tab list with what the adapter actually observed. */
export const syncTabs = mutation({
  args: {
    sessionId: v.id("browserSessions"),
    tabs: v.array(tabValidator),
    activeTabId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, session } = await requireSession(ctx, args.sessionId);
    if (!isLiveStatus(session.status)) return null;
    await replaceTabs(ctx, userId, session._id, args.tabs.slice(0, MAX_TABS));
    const activeTabId =
      args.activeTabId && args.tabs.some((t) => t.tabId === args.activeTabId)
        ? args.activeTabId
        : args.tabs[0]?.tabId;
    await ctx.db.patch("browserSessions", session._id, {
      activeTabId,
      status: "running",
      lastActivityAt: Date.now(),
    });
    return null;
  },
});

async function replaceTabs(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  sessionId: Id<"browserSessions">,
  tabs: Array<{ tabId: string; title: string; url: string; scrollY?: number }>,
) {
  const existing = await ctx.db
    .query("browserTabs")
    .withIndex("by_sessionId_and_position", (q) => q.eq("sessionId", sessionId))
    .take(MAX_TABS * 2);
  for (const row of existing) await ctx.db.delete("browserTabs", row._id);
  for (const [position, tab] of tabs.entries()) {
    await ctx.db.insert("browserTabs", {
      ownerId,
      sessionId,
      tabId: tab.tabId,
      title: tab.title.slice(0, 200),
      url: tab.url.slice(0, 2000),
      position,
      scrollY: tab.scrollY,
    });
  }
}

export const setPaused = mutation({
  args: { sessionId: v.id("browserSessions"), paused: v.boolean() },
  handler: async (ctx, args) => {
    const { session } = await requireSession(ctx, args.sessionId);
    await ctx.db.patch("browserSessions", session._id, { paused: args.paused });
    return null;
  },
});

export const setReconnecting = mutation({
  args: { sessionId: v.id("browserSessions") },
  handler: async (ctx, args) => {
    const { session } = await requireSession(ctx, args.sessionId);
    if (session.status === "running") {
      await ctx.db.patch("browserSessions", session._id, { status: "reconnecting" });
    }
    return null;
  },
});

/** Mark a session finished. Releases the run lock and expires open approvals. */
export const markEnded = mutation({
  args: {
    sessionId: v.id("browserSessions"),
    status: v.union(v.literal("ended"), v.literal("expired"), v.literal("error")),
    reason: v.string(),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { session } = await requireSession(ctx, args.sessionId);
    await endSession(ctx, session, args.status, args.reason, args.errorMessage);
    return null;
  },
});

async function endSession(
  ctx: MutationCtx,
  session: Doc<"browserSessions">,
  status: "ended" | "expired" | "error",
  reason: string,
  errorMessage?: string,
) {
  if (!isLiveStatus(session.status)) return;
  await ctx.db.patch("browserSessions", session._id, {
    status,
    endReason: reason,
    errorMessage,
    endedAt: Date.now(),
    controllingRunId: undefined,
  });
  const pending = await ctx.db
    .query("approvals")
    .withIndex("by_sessionId_and_status", (q) => q.eq("sessionId", session._id).eq("status", "pending"))
    .take(50);
  for (const a of pending) await ctx.db.patch("approvals", a._id, { status: "expired" });
}

// ---- Cleanup (cron) ----

export const listStale = internalQuery({
  args: { now: v.number(), idleMs: v.number() },
  handler: async (ctx, args) => {
    const stale: Array<{ _id: Id<"browserSessions">; provider: string; providerSessionId: string | null }> = [];
    for (const status of ["starting", "running", "reconnecting"] as const) {
      const rows = await ctx.db
        .query("browserSessions")
        .withIndex("by_status_and_lastActivityAt", (q) =>
          q.eq("status", status).lt("lastActivityAt", args.now - args.idleMs),
        )
        .take(50);
      for (const s of rows) {
        stale.push({ _id: s._id, provider: s.provider, providerSessionId: s.providerSessionId ?? null });
      }
    }
    // Sessions past their hard expiry, even if recently active.
    for (const status of ["running", "reconnecting"] as const) {
      const rows = await ctx.db
        .query("browserSessions")
        .withIndex("by_status_and_lastActivityAt", (q) => q.eq("status", status))
        .take(100);
      for (const s of rows) {
        if (s.expiresAt < args.now && !stale.some((x) => x._id === s._id)) {
          stale.push({ _id: s._id, provider: s.provider, providerSessionId: s.providerSessionId ?? null });
        }
      }
    }
    return stale;
  },
});

export const expireInternal = internalMutation({
  args: { sessionId: v.id("browserSessions"), reason: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db.get("browserSessions", args.sessionId);
    if (!session) return null;
    await endSession(ctx, session, "expired", args.reason);
    return null;
  },
});

// ---- Settings ----

export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db
      .query("userSettings")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
      .unique();
    return row
      ? { extraAllowedDomains: row.extraAllowedDomains, showCursor: row.showCursor }
      : { extraAllowedDomains: [] as string[], showCursor: true };
  },
});

export const updateSettings = mutation({
  args: { extraAllowedDomains: v.array(v.string()), showCursor: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const domains = args.extraAllowedDomains
      .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
      .slice(0, 50);
    const row = await ctx.db
      .query("userSettings")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
      .unique();
    if (row) {
      await ctx.db.patch("userSettings", row._id, { extraAllowedDomains: domains, showCursor: args.showCursor });
    } else {
      await ctx.db.insert("userSettings", { ownerId: userId, extraAllowedDomains: domains, showCursor: args.showCursor });
    }
    return null;
  },
});
