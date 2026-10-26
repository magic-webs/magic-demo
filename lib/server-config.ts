import "server-only";
import { trustedPrefixesFor } from "@/lib/browser/url-safety";

function int(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function list(name: string, fallback: string[]) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export type BrowserMode = "selfhosted" | "browserbase" | "demo";

export function getServerConfig() {
  const browserbaseConfigured = Boolean(process.env.BROWSERBASE_API_KEY);
  const gatewayConfigured = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
  const workerConfigured = Boolean(process.env.BROWSER_WORKER_URL && process.env.BROWSER_WORKER_SECRET);
  // auto: self-hosted worker first, then Browserbase, else the labelled demo simulation.
  const requestedMode = process.env.BROWSER_MODE ?? "auto";
  const browserMode: BrowserMode =
    requestedMode === "demo"
      ? "demo"
      : requestedMode === "browserbase" && browserbaseConfigured
        ? "browserbase"
        : workerConfigured
          ? "selfhosted"
          : browserbaseConfigured
            ? "browserbase"
            : "demo";

  const demoSiteUrl = process.env.DEMO_SITE_URL?.replace(/\/$/, "") || null;
  const demoHost = demoSiteUrl ? new URL(demoSiteUrl).hostname : null;

  return {
    model: process.env.AI_MODEL || "anthropic/claude-sonnet-5.5",
    gatewayConfigured,
    browserMode,
    worker: {
      url: (process.env.BROWSER_WORKER_URL ?? "").replace(/\/$/, ""),
      // URL the user's browser uses for the live view (may differ behind a proxy).
      publicUrl: (process.env.BROWSER_WORKER_PUBLIC_URL || process.env.BROWSER_WORKER_URL || "").replace(/\/$/, ""),
      secret: process.env.BROWSER_WORKER_SECRET ?? "",
    },
    // Exact local origin+path exceptions for the built-in sample site (e.g. http://localhost:3000/sample).
    trustedPrefixes: browserMode === "selfhosted" ? trustedPrefixesFor(demoSiteUrl) : [],
    browserbase: {
      apiKey: process.env.BROWSERBASE_API_KEY ?? "",
      projectId: process.env.BROWSERBASE_PROJECT_ID || undefined,
      // keepAlive needs a paid Browserbase plan. Without it the session ends when
      // the server process disconnects (see README "Free plan").
      keepAlive: process.env.BROWSERBASE_KEEP_ALIVE !== "false",
      region: (process.env.BROWSERBASE_REGION as "us-west-2" | "us-east-1" | "eu-central-1" | "ap-southeast-1" | undefined) || undefined,
    },
    sessionTimeoutSec: int("BROWSER_SESSION_TIMEOUT_SEC", 900, 60, 21600),
    maxTabs: int("BROWSER_MAX_TABS", 6, 1, 8),
    // "*" disables the allowlist (private/unsafe targets stay blocked).
    allowedDomains: Array.from(
      new Set([
        ...list("ALLOWED_DOMAINS", ["agent.magicwebs.ai", "magicwebs.ai", "youtube.com", "example.com", "wikipedia.org"]),
        // A public demo host joins the allowlist; a local one is handled by trustedPrefixes instead.
        ...(demoHost && trustedPrefixesFor(demoSiteUrl).length === 0 ? [demoHost] : []),
      ]),
    ),
    demoSiteUrl,
    limits: {
      maxSteps: int("AGENT_MAX_STEPS", 15, 1, 50),
      maxRunMs: int("AGENT_MAX_RUN_SECONDS", 150, 20, 780) * 1000,
      maxOutputTokens: int("AGENT_MAX_OUTPUT_TOKENS", 1500, 200, 8000),
      maxTotalTokens: int("AGENT_MAX_TOTAL_TOKENS", 200000, 5000, 2000000),
      toolTimeoutMs: int("AGENT_TOOL_TIMEOUT_SECONDS", 45, 5, 120) * 1000,
    },
  };
}

export type ServerConfig = ReturnType<typeof getServerConfig>;
