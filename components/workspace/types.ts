import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

export type AppConfig = {
  browserMode: "selfhosted" | "browserbase" | "demo";
  gatewayConfigured: boolean;
  model: string | null;
  demoSiteUrl: string | null;
  keepAlive: boolean;
  allowedDomains: string[];
};

export type SessionView = NonNullable<FunctionReturnType<typeof api.browserSessions.getForConversation>>;
export type ActionLogView = FunctionReturnType<typeof api.actionLogs.listForConversation>[number];
export type ApprovalView = FunctionReturnType<typeof api.approvals.listForConversation>[number];

export async function postJson<T = { ok: boolean; summary?: string; error?: { message: string } | null }>(url: string, body: unknown, method = "POST") {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } | null };
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data;
}
