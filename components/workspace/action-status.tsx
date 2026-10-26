import { CheckCircle2, Hand, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type ActionStatus = "executing" | "completed" | "failed" | "awaiting_approval" | "blocked";

const styles: Record<ActionStatus, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  executing: { label: "Running", className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300", Icon: Loader2 },
  completed: { label: "Done", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", Icon: CheckCircle2 },
  failed: { label: "Failed", className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300", Icon: XCircle },
  awaiting_approval: { label: "Needs approval", className: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300", Icon: Hand },
  blocked: { label: "Blocked", className: "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300", Icon: ShieldAlert },
};

export function actionStyle(status: ActionStatus) {
  return styles[status];
}

export function StatusIcon({ status, className }: { status: ActionStatus; className?: string }) {
  const { Icon } = styles[status];
  return <Icon className={cn("size-4 shrink-0", status === "executing" && "animate-spin", className)} />;
}
