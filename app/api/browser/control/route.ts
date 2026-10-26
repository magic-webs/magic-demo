import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getServerConfig } from "@/lib/server-config";
import { convexAs, convexErrorMessage, jsonError, requireToken } from "@/lib/convex-server";
import { AgentRuntime } from "@/lib/agent/runtime";
import { browserActions, executeApproval } from "@/lib/agent/actions";

export const maxDuration = 60;

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("navigate"), conversationId: z.string(), url: z.string().min(1).max(2000) }),
  z.object({ op: z.literal("back"), conversationId: z.string() }),
  z.object({ op: z.literal("forward"), conversationId: z.string() }),
  z.object({ op: z.literal("newTab"), conversationId: z.string(), url: z.string().max(2000).nullable() }),
  z.object({ op: z.literal("switchTab"), conversationId: z.string(), tabId: z.string().min(1).max(100) }),
  z.object({ op: z.literal("closeTab"), conversationId: z.string(), tabId: z.string().min(1).max(100) }),
  z.object({ op: z.literal("executeApproval"), conversationId: z.string(), approvalId: z.string().min(1) }),
]);

/** Browser controls the user drives directly (address bar, tabs, approved actions). */
export async function POST(req: Request) {
  const token = await requireToken();
  if (!token) return jsonError(401, "Sign in first.", "UNAUTHENTICATED");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Invalid request.");
  const body = parsed.data;
  const convex = convexAs(token);
  const conversationId = body.conversationId as Id<"conversations">;

  try {
    const rt = await new AgentRuntime(convex, getServerConfig(), conversationId, null).init();
    if (!rt.sessionId && body.op !== "navigate" && body.op !== "newTab") {
      return jsonError(409, "No browser session is running.", "NO_SESSION");
    }
    if (rt.sessionId) {
      const current = await convex.query(api.browserSessions.getForConversation, { conversationId });
      // Don't fight the assistant: the user must pause it first (approvals are the exception).
      if (current?.session.controllingRunId && !current.session.paused && body.op !== "executeApproval") {
        return jsonError(409, "The assistant is working. Pause or stop it before using the controls.", "BUSY");
      }
    }
    const key = `user:${crypto.randomUUID()}`;
    const result =
      body.op === "navigate"
        ? await browserActions.openUrl(rt, key, body.url)
        : body.op === "back"
          ? await browserActions.goBack(rt, key)
          : body.op === "forward"
            ? await browserActions.goForward(rt, key)
            : body.op === "newTab"
              ? await browserActions.openTab(rt, key, body.url)
              : body.op === "switchTab"
                ? await browserActions.switchTab(rt, key, body.tabId)
                : body.op === "closeTab"
                  ? await browserActions.closeTab(rt, key, body.tabId)
                  : await executeApproval(rt, body.approvalId as Id<"approvals">);
    // Never return page content to the client from here; the live view shows it.
    return Response.json(
      { ok: result.ok, summary: result.summary, page: result.page ?? null, error: result.error ?? null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const e = convexErrorMessage(err);
    return jsonError(400, e.message, e.code);
  }
}
