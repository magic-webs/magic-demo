import { cn } from "@/lib/utils";
import { actionStyle, StatusIcon, type ActionStatus } from "./action-status";

type ToolPart = {
  type: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error" | string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

const LABELS: Record<string, (input: Record<string, unknown>) => string> = {
  createBrowserSession: () => "Start browser session",
  observePage: () => "Look at the page",
  openUrl: (i) => `Open ${String(i.url ?? "")}`,
  clickElement: (i) => `Click ${String(i.why ?? "element")}`,
  fillField: (i) => `Type “${String(i.text ?? "").slice(0, 40)}”${i.submit ? " + Enter" : ""}`,
  scrollPage: (i) => `Scroll ${i.amount === "top" || i.amount === "bottom" ? `to ${String(i.amount)}` : String(i.direction ?? "")}`,
  goBack: () => "Go back",
  goForward: () => "Go forward",
  openTab: (i) => (i.url ? `New tab: ${String(i.url)}` : "Open new tab"),
  listTabs: () => "List tabs",
  switchTab: () => "Switch tab",
  closeTab: () => "Close tab",
  endBrowserSession: () => "End browser session",
};

/** One assistant action inside the chat. Shows the verified result, not hidden reasoning. */
export function ToolChip({ part }: { part: ToolPart }) {
  const name = part.type.replace(/^tool-/, "");
  const input = (part.input ?? {}) as Record<string, unknown>;
  const output = part.output as { ok?: boolean; summary?: string; approvalId?: string; error?: { code?: string } } | undefined;

  let status: ActionStatus = "executing";
  if (part.state === "output-error") status = "failed";
  else if (part.state === "output-available") {
    status = output?.approvalId ? "awaiting_approval" : output?.ok ? "completed" : output?.error?.code === "NAVIGATION_BLOCKED" ? "blocked" : "failed";
  }
  const style = actionStyle(status);
  const summary = part.state === "output-error" ? part.errorText : output?.summary;

  return (
    <div className={cn("flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs", style.className)}>
      <StatusIcon status={status} className="mt-px size-3.5" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{(LABELS[name] ?? (() => name))(input)}</div>
        {summary && <div className="mt-0.5 break-words opacity-80">{summary}</div>}
      </div>
    </div>
  );
}
