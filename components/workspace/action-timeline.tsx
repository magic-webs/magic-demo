import { format } from "date-fns";
import { ListChecks } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { actionStyle, StatusIcon } from "./action-status";
import type { ActionLogView } from "./types";

export function ActionTimeline({ actions }: { actions: ActionLogView[] }) {
  if (actions.length === 0) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon"><ListChecks /></EmptyMedia>
          <EmptyTitle>No actions yet</EmptyTitle>
          <EmptyDescription>Every browser action the assistant (or you) takes shows up here with its verified result.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ScrollArea className="h-full">
      <ol className="relative flex flex-col gap-3 p-4">
        {[...actions].reverse().map((a) => {
          const style = actionStyle(a.status);
          return (
            <li key={a._id} className="flex gap-3">
              <div className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border", style.className)}>
                <StatusIcon status={a.status} className="size-3.5" />
              </div>
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{a.label}</span>
                  <span className={cn("rounded-full border px-1.5 text-[10px]", style.className)}>{style.label}</span>
                </div>
                {a.summary && <p className="mt-0.5 text-xs break-words text-muted-foreground">{a.summary}</p>}
                {a.pageUrl && <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={a.pageUrl}>{a.pageUrl}</p>}
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {format(a.startedAt, "HH:mm:ss")}
                  {a.endedAt ? ` · ${((a.endedAt - a.startedAt) / 1000).toFixed(1)}s` : ""}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </ScrollArea>
  );
}
