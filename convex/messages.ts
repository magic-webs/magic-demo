import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireConversation } from "./lib/access";

const MAX_HISTORY = 200;

export const list = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireConversation(ctx, args.conversationId);
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(MAX_HISTORY);
    return rows.reverse().map((m) => ({
      id: m.messageId,
      role: m.role,
      parts: m.parts,
    }));
  },
});

/** Insert or replace a message by its stable UI message id (idempotent on retries). */
export async function upsertMessage(
  ctx: MutationCtx,
  row: {
    ownerId: Id<"users">;
    conversationId: Id<"conversations">;
    messageId: string;
    role: "user" | "assistant" | "system";
    parts: unknown;
    runId?: Id<"agentRuns">;
  },
) {
  const existing = await ctx.db
    .query("messages")
    .withIndex("by_conversationId_and_messageId", (q) =>
      q.eq("conversationId", row.conversationId).eq("messageId", row.messageId),
    )
    .unique();
  if (existing) {
    await ctx.db.patch("messages", existing._id, { parts: row.parts, runId: row.runId });
    return existing._id;
  }
  return await ctx.db.insert("messages", row);
}

export const saveAssistantMessage = mutation({
  args: {
    conversationId: v.id("conversations"),
    messageId: v.string(),
    parts: v.any(),
    runId: v.optional(v.id("agentRuns")),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireConversation(ctx, args.conversationId);
    if (args.runId) {
      const run = await ctx.db.get("agentRuns", args.runId);
      if (!run || run.conversationId !== args.conversationId) {
        throw new Error("Run does not belong to this conversation.");
      }
    }
    await upsertMessage(ctx, {
      ownerId: userId,
      conversationId: args.conversationId,
      messageId: args.messageId,
      role: "assistant",
      parts: args.parts,
      runId: args.runId,
    });
    await ctx.db.patch("conversations", args.conversationId, { lastMessageAt: Date.now() });
    return null;
  },
});
