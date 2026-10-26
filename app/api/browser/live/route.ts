import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getServerConfig } from "@/lib/server-config";
import { convexAs, convexErrorMessage, jsonError, requireToken } from "@/lib/convex-server";
import { getProvider } from "@/lib/browser/remote-providers";

/**
 * Returns short-lived, per-tab live-view URLs for the caller's own session.
 * These URLs grant control of the remote browser: never log or persist them.
 */
export async function GET(req: Request) {
  const token = await requireToken();
  if (!token) return jsonError(401, "Sign in first.", "UNAUTHENTICATED");
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return jsonError(400, "sessionId required");

  const convex = convexAs(token);
  let view;
  try {
    view = await convex.query(api.browserSessions.getInternalView, { sessionId: sessionId as Id<"browserSessions"> });
  } catch (err) {
    const e = convexErrorMessage(err);
    return jsonError(404, e.message, e.code);
  }
  const headers = { "Cache-Control": "no-store, private" };
  if (view.provider === "demo") {
    return Response.json({ provider: "demo", pages: [] }, { headers });
  }
  if (!["running", "reconnecting"].includes(view.status) || !view.providerSessionId) {
    return Response.json({ provider: view.provider, pages: [], status: view.status }, { headers });
  }
  // Input-capable viewer tokens only on explicit takeover, and only while paused.
  const interactive = url.searchParams.get("interactive") === "1" && view.paused;
  try {
    const pages = await getProvider(getServerConfig(), view.provider).liveView(view.providerSessionId, view.tabs, { interactive });
    return Response.json({ provider: view.provider, pages }, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : "unknown";
    return jsonError(502, `Live view unavailable: ${message}`, "LIVE_VIEW_FAILED");
  }
}
