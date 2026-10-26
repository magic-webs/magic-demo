import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getServerConfig } from "@/lib/server-config";
import { convexAs, convexErrorMessage, jsonError, requireToken } from "@/lib/convex-server";
import { AgentRuntime } from "@/lib/agent/runtime";

export const maxDuration = 60;

async function setup(req: Request) {
  const token = await requireToken();
  if (!token) return { error: jsonError(401, "Sign in first.", "UNAUTHENTICATED") } as const;
  const body = (await req.json().catch(() => null)) as { conversationId?: unknown } | null;
  if (!body || typeof body.conversationId !== "string") return { error: jsonError(400, "conversationId required") } as const;
  const convex = convexAs(token);
  try {
    const rt = await new AgentRuntime(convex, getServerConfig(), body.conversationId as Id<"conversations">, null).init();
    return { rt, convex } as const;
  } catch (err) {
    const e = convexErrorMessage(err);
    return { error: jsonError(e.code === "NOT_FOUND" ? 404 : 400, e.message, e.code) } as const;
  }
}

/** Start button: create a remote browser session for the conversation. */
export async function POST(req: Request) {
  const s = await setup(req);
  if ("error" in s) return s.error;
  try {
    const { created } = await s.rt.createSession();
    return Response.json({ ok: true, created, sessionId: s.rt.sessionId }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const e = convexErrorMessage(err);
    return jsonError(502, e.message, e.code);
  }
}

/** Stop button: stop any run, release the remote browser, mark the session ended. */
export async function DELETE(req: Request) {
  const s = await setup(req);
  if ("error" in s) return s.error;
  try {
    await s.convex.mutation(api.agentRuns.requestStop, { conversationId: s.rt.conversationId });
    await s.rt.endSession("Stopped by user");
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const e = convexErrorMessage(err);
    return jsonError(500, e.message, e.code);
  }
}
