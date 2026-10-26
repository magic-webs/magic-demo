import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type Ctx = QueryCtx | MutationCtx;

/** Returns the signed-in user's id, derived from the auth token. Never from args. */
export async function requireUserId(ctx: Ctx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in first." });
  }
  return userId;
}

function notFound(what: string): never {
  // Same error for "missing" and "not yours" so ids can't be probed.
  throw new ConvexError({ code: "NOT_FOUND", message: `${what} not found.` });
}

export async function requireConversation(
  ctx: Ctx,
  conversationId: Id<"conversations">,
) {
  const userId = await requireUserId(ctx);
  const conversation = await ctx.db.get("conversations", conversationId);
  if (!conversation || conversation.ownerId !== userId) notFound("Conversation");
  return { userId, conversation };
}

export async function requireSession(ctx: Ctx, sessionId: Id<"browserSessions">) {
  const userId = await requireUserId(ctx);
  const session = await ctx.db.get("browserSessions", sessionId);
  if (!session || session.ownerId !== userId) notFound("Browser session");
  return { userId, session };
}

export async function requireRun(ctx: Ctx, runId: Id<"agentRuns">) {
  const userId = await requireUserId(ctx);
  const run = await ctx.db.get("agentRuns", runId);
  if (!run || run.ownerId !== userId) notFound("Agent run");
  return { userId, run };
}

export async function requireApproval(ctx: Ctx, approvalId: Id<"approvals">) {
  const userId = await requireUserId(ctx);
  const approval = await ctx.db.get("approvals", approvalId);
  if (!approval || approval.ownerId !== userId) notFound("Approval");
  return { userId, approval };
}

export const LIVE_SESSION_STATUSES = ["starting", "running", "reconnecting"] as const;

export function isLiveStatus(status: string) {
  return (LIVE_SESSION_STATUSES as readonly string[]).includes(status);
}
