import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { isLiveStatus, requireConversation, requireRun, requireSession } from "./lib/access";
import { upsertMessage } from "./messages";

async function liveSessionFor(ctx: MutationCtx, conversation: Doc<"conversations">) {
  const latest = await ctx.db
    .query("browserSessions")
    .withIndex("by_conversationId", (q) => q.eq("conversationId", conversation._id))
    .order("desc")
    .first();
  return latest && isLiveStatus(latest.status) ? latest : null;
}

/**
 * Start a bounded agent run for a user message.
 * - Saves the user message (idempotent by message id).
 * - Supersedes any older run in this conversation, so a new instruction interrupts the old plan.
 * - Takes the browser-session lock so only this run may act.
 */
export const start = mutation({
  args: {
    conversationId: v.id("conversations"),
    userMessage: v.object({ id: v.string(), parts: v.any() }),
    model: v.string(),
    maxRunMs: v.number(),
  },
  handler: async (ctx, args) => {
    const { userId, conversation } = await requireConversation(ctx, args.conversationId);

    const previous = await ctx.db
      .query("agentRuns")
      .withIndex("by_conversationId_and_userMessageId", (q) =>
        q.eq("conversationId", conversation._id).eq("userMessageId", args.userMessage.id),
      )
      .first();
    if (previous) {
      const stale = previous.status === "running" && previous.startedAt < Date.now() - args.maxRunMs;
      if (!stale) {
        // Retry/reconnect of a message that is answered or still being answered: don't act twice.
        return { runId: previous._id, duplicate: true as const, sessionId: null };
      }
      await ctx.db.patch("agentRuns", previous._id, {
        status: "failed",
        error: "Run did not finish (server restarted or timed out).",
        endedAt: Date.now(),
      });
    }

    await upsertMessage(ctx, {
      ownerId: userId,
      conversationId: conversation._id,
      messageId: args.userMessage.id,
      role: "user",
      parts: args.userMessage.parts,
    });

    const firstText = Array.isArray(args.userMessage.parts)
      ? (args.userMessage.parts as Array<{ type?: string; text?: string }>).find((p) => p.type === "text")?.text
      : undefined;
    await ctx.db.patch("conversations", conversation._id, {
      lastMessageAt: Date.now(),
      ...(conversation.title === "New conversation" && firstText
        ? { title: firstText.slice(0, 60) }
        : {}),
    });

    const running = await ctx.db
      .query("agentRuns")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", conversation._id))
      .order("desc")
      .take(10);
    for (const r of running) {
      if (r.status === "running") {
        await ctx.db.patch("agentRuns", r._id, {
          status: "superseded",
          stopRequested: true,
          endedAt: Date.now(),
        });
      }
    }

    const session = await liveSessionFor(ctx, conversation);
    const runId = await ctx.db.insert("agentRuns", {
        ownerId: userId,
        conversationId: conversation._id,
        sessionId: session?._id,
        userMessageId: args.userMessage.id,
        status: "running",
        stopRequested: false,
        stepCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        model: args.model,
        startedAt: Date.now(),
      });
    if (session) {
      await ctx.db.patch("browserSessions", session._id, { controllingRunId: runId });
    }
    return { runId, duplicate: false as const, sessionId: session?._id ?? null };
  },
});

/** Called when the run creates a browser session mid-run. */
export const attachSession = mutation({
  args: { runId: v.id("agentRuns"), sessionId: v.id("browserSessions") },
  handler: async (ctx, args) => {
    const { run } = await requireRun(ctx, args.runId);
    const { session } = await requireSession(ctx, args.sessionId);
    if (session.conversationId !== run.conversationId) throw new Error("Session mismatch.");
    await ctx.db.patch("agentRuns", run._id, { sessionId: session._id });
    if (run.status === "running") {
      await ctx.db.patch("browserSessions", session._id, { controllingRunId: run._id });
    }
    return null;
  },
});

/** Whether this run may still take browser actions. Checked before every action. */
export const getControl = query({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, args) => {
    const { run } = await requireRun(ctx, args.runId);
    if (run.status !== "running" || run.stopRequested) {
      return { canAct: false, reason: run.status === "superseded" ? "superseded" : "stopped" } as const;
    }
    if (run.sessionId) {
      const session = await ctx.db.get("browserSessions", run.sessionId);
      if (session && session.paused) return { canAct: false, reason: "paused" } as const;
      if (session && isLiveStatus(session.status) && session.controllingRunId !== run._id) {
        return { canAct: false, reason: "superseded" } as const;
      }
    }
    return { canAct: true, reason: null } as const;
  },
});

export const recordStep = mutation({
  args: { runId: v.id("agentRuns"), inputTokens: v.number(), outputTokens: v.number() },
  handler: async (ctx, args) => {
    const { run } = await requireRun(ctx, args.runId);
    await ctx.db.patch("agentRuns", run._id, {
      stepCount: run.stepCount + 1,
      inputTokens: run.inputTokens + args.inputTokens,
      outputTokens: run.outputTokens + args.outputTokens,
    });
    return null;
  },
});

export const finish = mutation({
  args: {
    runId: v.id("agentRuns"),
    status: v.union(v.literal("completed"), v.literal("paused"), v.literal("stopped"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { run } = await requireRun(ctx, args.runId);
    const now = Date.now();
    if (run.status === "running") {
      await ctx.db.patch("agentRuns", run._id, {
        status: run.stopRequested ? "stopped" : args.status,
        error: args.error?.slice(0, 500),
        endedAt: now,
      });
    }
    await ctx.db.insert("usageRecords", {
      ownerId: run.ownerId,
      runId: run._id,
      model: run.model,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      steps: run.stepCount,
      durationMs: now - run.startedAt,
    });
    if (run.sessionId) {
      const session = await ctx.db.get("browserSessions", run.sessionId);
      if (session && session.controllingRunId === run._id) {
        await ctx.db.patch("browserSessions", session._id, { controllingRunId: undefined });
      }
    }
    return null;
  },
});

/** Stop button: cancel every running run in the conversation. */
export const requestStop = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const { conversation } = await requireConversation(ctx, args.conversationId);
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", conversation._id))
      .order("desc")
      .take(10);
    for (const r of runs) {
      if (r.status === "running") {
        await ctx.db.patch("agentRuns", r._id, { status: "stopped", stopRequested: true, endedAt: Date.now() });
      }
    }
    return null;
  },
});

export const activeForConversation = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireConversation(ctx, args.conversationId);
    const latest = await ctx.db
      .query("agentRuns")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .first();
    if (!latest) return null;
    return { _id: latest._id, status: latest.status, stepCount: latest.stepCount, error: latest.error ?? null };
  },
});
