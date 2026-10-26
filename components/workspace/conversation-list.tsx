"use client";

import { useMutation } from "convex/react";
import { Bot, MessageSquare, Plus, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
}: {
  conversations: Doc<"conversations">[];
  activeId: Id<"conversations"> | null;
  onSelect: (id: Id<"conversations">) => void;
  onNew: () => void;
}) {
  const remove = useMutation(api.conversations.remove);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-2 border-b px-3">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Bot className="size-4" />
        </div>
        <span className="text-sm font-semibold">Magic Assistant</span>
      </div>
      <div className="p-2">
        <Button variant="outline" className="w-full justify-start" onClick={onNew}>
          <Plus /> New conversation
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <nav className="flex flex-col gap-0.5 p-2" aria-label="Conversations">
          {conversations.map((c) => (
            <div
              key={c._id}
              className={cn(
                "group flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-sidebar-accent",
                c._id === activeId && "bg-sidebar-accent font-medium",
              )}
            >
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onSelect(c._id)}>
                <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{c.title}</span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {formatDistanceToNow(c.lastMessageAt, { addSuffix: true })}
                  </span>
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={`Delete ${c.title}`}
                onClick={() => {
                  if (confirm(`Delete “${c.title}”?`)) {
                    remove({ conversationId: c._id }).catch((e: Error) => alert(e.message));
                  }
                }}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </nav>
      </ScrollArea>
    </div>
  );
}
