import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireApproval, requireConversation, requireSession } from "./lib/access";

const APPROVAL_TTL_MS = 10 * 60 * 1000;

const actionValidator = v.object({
  kind: v.union(v.literal("click"), v.literal("fill")),
  tabId: v.string(),
  pageUrl: v.string(),
  elementRole: v.string(),
  elementName: v.string(),
  text: v.optional(v.string()),
  submit: v.optional(v.boolean()),
});

/** Created by the agent's tool layer when an action is consequential. */
export const create = mutation({
  args: {
    conversationId: v.id("conversations"),
    sessionId: v.id("browserSessions"),
    runId: v.optional(v.id("agentRuns")),
    actionLogId: v.optional(v.id("actionLogs")),
    action: actionValidator,
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireConversation(ctx, args.conversationId);
    const { session } = await requireSession(ctx, args.sessionId);
    if (session.conversationId !== args.conversationId) throw new Error("Session mismatch.");
    return await ctx.db.insert("approvals", {
      ownerId: userId,
      conversationId: args.conversationId,
      sessionId: args.sessionId,
      runId: args.runId,
      actionLogId: args.actionLogId,
      action: args.action,
      reason: args.reason.slice(0, 300),
      status: "pending",
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    });
  },
});

export const listForConversation = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireConversation(ctx, args.conversationId);
    const rows = [];
    for (const status of ["pending", "approved", "executing"] as const) {
      rows.push(
        ...(await ctx.db
          .query("approvals")
          .withIndex("by_conversationId_and_status", (q) =>
            q.eq("conversationId", args.conversationId).eq("status", status),
          )
          .take(20)),
      );
    }
    return rows.map((a) => ({
      _id: a._id,
      action: { ...a.action, text: a.action.text ? `${a.action.text.slice(0, 80)}` : undefined },
      reason: a.reason,
      status: a.status,
      expiresAt: a.expiresAt,
    }));
  },
});

/** Only the signed-in user can decide. Approval is bound to the stored action. */
export const decide = mutation({
  args: { approvalId: v.id("approvals"), decision: v.union(v.literal("approve"), v.literal("deny")) },
  handler: async (ctx, args) => {
    const { approval } = await requireApproval(ctx, args.approvalId);
    if (approval.status !== "pending") {
      throw new ConvexError({ code: "APPROVAL_CLOSED", message: `Approval is already ${approval.status}.` });
    }
    if (approval.expiresAt < Date.now()) {
      await ctx.db.patch("approvals", approval._id, { status: "expired" });
      throw new ConvexError({ code: "APPROVAL_EXPIRED", message: "Approval expired. Ask the assistant again." });
    }
    await ctx.db.patch("approvals", approval._id, {
      status: args.decision === "approve" ? "approved" : "denied",
      decidedAt: Date.now(),
    });
    if (approval.actionLogId && args.decision === "deny") {
      await ctx.db.patch("actionLogs", approval.actionLogId, {
        status: "blocked",
        summary: "Denied by user.",
        endedAt: Date.now(),
      });
    }
    return null;
  },
});

/** Atomically move approved -> executing so the action runs at most once. */
export const claimForExecution = mutation({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    const { approval } = await requireApproval(ctx, args.approvalId);
    if (approval.status !== "approved") {
      throw new ConvexError({ code: "APPROVAL_NOT_APPROVED", message: `Approval is ${approval.status}.` });
    }
    if (approval.expiresAt < Date.now()) {
      await ctx.db.patch("approvals", approval._id, { status: "expired" });
      throw new ConvexError({ code: "APPROVAL_EXPIRED", message: "Approval expired." });
    }
    await ctx.db.patch("approvals", approval._id, { status: "executing" });
    return {
      _id: approval._id,
      conversationId: approval.conversationId,
      sessionId: approval.sessionId,
      actionLogId: approval.actionLogId ?? null,
      action: approval.action,
    };
  },
});

export const markExecuted = mutation({
  args: { approvalId: v.id("approvals"), ok: v.boolean(), summary: v.string() },
  handler: async (ctx, args) => {
    const { approval } = await requireApproval(ctx, args.approvalId);
    if (approval.status !== "executing") return null;
    await ctx.db.patch("approvals", approval._id, {
      status: args.ok ? "executed" : "failed",
      resultSummary: args.summary.slice(0, 500),
    });
    if (approval.actionLogId) {
      await ctx.db.patch("actionLogs", approval.actionLogId, {
        status: args.ok ? "completed" : "failed",
        summary: args.summary.slice(0, 500),
        endedAt: Date.now(),
      });
    }
    return null;
  },
});
