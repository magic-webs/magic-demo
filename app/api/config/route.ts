import { getServerConfig } from "@/lib/server-config";
import { jsonError, requireToken } from "@/lib/convex-server";

/** Non-secret capability flags so the UI can label demo vs live modes honestly. */
export async function GET() {
  if (!(await requireToken())) return jsonError(401, "Sign in first.", "UNAUTHENTICATED");
  const c = getServerConfig();
  return Response.json(
    {
      browserMode: c.browserMode,
      gatewayConfigured: c.gatewayConfigured,
      model: c.gatewayConfigured ? c.model : null,
      demoSiteUrl: c.browserMode === "demo" ? "/sample" : c.demoSiteUrl,
      keepAlive: c.browserbase.keepAlive,
      allowedDomains: c.allowedDomains,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
