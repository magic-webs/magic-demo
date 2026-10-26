import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { actionStatus } from "./schema";
import { requireConversation, requireUserId } from "./lib/access";

/**
 * Gate + log for one browser action. Atomically checks that the run still holds
 * control (not stopped, paused or superseded) before the action may execute.
 * The idempotency key makes retries of the same tool call a no-op.
 */
export const begin = mutation({
  args: {
    conversationId: v.id("conversations"),
    runId: v.optional(v.id("agentRuns")),
    sessionId: v.optional(v.id("browserSessions")),
    idempotencyKey: v.string(),
    tool: v.string(),
    label: v.string(),
    // Read-only actions (observe, list tabs) may run while paused.
    readOnly: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireConversation(ctx, args.conversationId);

    const existing = await ctx.db
      .query("actionLogs")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (existing) {
      if (existing.ownerId !== userId) throw new Error("Not found.");
      return { allowed: false as const, reason: "duplicate" as const, logId: existing._id, previous: existing.summary ?? null };
    }

    let blockedReason: "stopped" | "paused" | "superseded" | null = null;
    if (args.runId) {
      const run = await ctx.db.get("agentRuns", args.runId);
      if (!run || run.ownerId !== userId || run.conversationId !== args.conversationId) {
        throw new Error("Run not found.");
      }
      if (run.status === "superseded") blockedReason = "superseded";
      else if (run.status !== "running" || run.stopRequested) blockedReason = "stopped";
      const sessionId = args.sessionId ?? run.sessionId;
      if (!blockedReason && sessionId) {
        const session = await ctx.db.get("browserSessions", sessionId);
        if (session && session.ownerId === userId) {
          if (session.paused && !args.readOnly) blockedReason = "paused";
          else if (session.controllingRunId && session.controllingRunId !== run._id) blockedReason = "superseded";
        }
      }
    }

    const logId = await ctx.db.insert("actionLogs", {
      ownerId: userId,
      conversationId: args.conversationId,
      runId: args.runId,
      sessionId: args.sessionId,
      idempotencyKey: args.idempotencyKey,
      tool: args.tool,
      label: args.label.slice(0, 160),
      status: blockedReason ? "blocked" : "executing",
      summary: blockedReason ? `Not executed: run ${blockedReason}.` : undefined,
      startedAt: Date.now(),
      endedAt: blockedReason ? Date.now() : undefined,
    });
    if (blockedReason) return { allowed: false as const, reason: blockedReason, logId, previous: null };
    if (args.sessionId) {
      await ctx.db.patch("browserSessions", args.sessionId, { lastActivityAt: Date.now() });
    }
    return { allowed: true as const, reason: null, logId, previous: null };
  },
});

export const complete = mutation({
  args: {
    logId: v.id("actionLogs"),
    status: actionStatus,
    summary: v.string(),
    pageTitle: v.optional(v.string()),
    pageUrl: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    approvalId: v.optional(v.id("approvals")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const log = await ctx.db.get("actionLogs", args.logId);
    if (!log || log.ownerId !== userId) throw new Error("Not found.");
    await ctx.db.patch("actionLogs", log._id, {
      status: args.status,
      summary: args.summary.slice(0, 500),
      pageTitle: args.pageTitle?.slice(0, 200),
      pageUrl: args.pageUrl?.slice(0, 2000),
      errorCode: args.errorCode,
      approvalId: args.approvalId,
      endedAt: Date.now(),
    });
    return null;
  },
});

export const listForConversation = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireConversation(ctx, args.conversationId);
    const rows = await ctx.db
      .query("actionLogs")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(60);
    return rows.reverse().map((r) => ({
      _id: r._id,
      tool: r.tool,
      label: r.label,
      status: r.status,
      summary: r.summary ?? null,
      pageTitle: r.pageTitle ?? null,
      pageUrl: r.pageUrl ?? null,
      errorCode: r.errorCode ?? null,
      approvalId: r.approvalId ?? null,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
    }));
  },
});
