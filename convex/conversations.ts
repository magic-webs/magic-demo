import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireConversation, requireUserId } from "./lib/access";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    return await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_lastMessageAt", (q) => q.eq("ownerId", userId))
      .order("desc")
      .take(50);
  },
});

export const get = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const { conversation } = await requireConversation(ctx, args.conversationId);
    return conversation;
  },
});

export const create = mutation({
  args: { title: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await ctx.db.insert("conversations", {
      ownerId: userId,
      title: (args.title ?? "New conversation").slice(0, 80),
      lastMessageAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { conversationId: v.id("conversations"), title: v.string() },
  handler: async (ctx, args) => {
    await requireConversation(ctx, args.conversationId);
    const title = args.title.trim().slice(0, 80);
    if (!title) return null;
    await ctx.db.patch("conversations", args.conversationId, { title });
    return null;
  },
});

export const remove = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireConversation(ctx, args.conversationId);
    const live = await ctx.db
      .query("browserSessions")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .take(20);
    if (live.some((s) => s.status === "running" || s.status === "starting")) {
      throw new Error("Stop the browser session before deleting this conversation.");
    }
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .take(500);
    for (const m of messages) await ctx.db.delete("messages", m._id);
    await ctx.db.delete("conversations", args.conversationId);
    return null;
  },
});
