"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Bot, ListChecks, Loader2, MessageSquare, Square } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ActionTimeline } from "./action-timeline";
import { ApprovalCard } from "./approval-card";
import { ToolChip } from "./tool-chip";
import type { AppConfig } from "./types";

const SUGGESTIONS = [
  "Open the demo website, go to pricing and scroll down",
  "Open https://agent.magicwebs.ai and explain what it does",
  "Open the demo records and search for Pune",
  "Open YouTube in a new tab",
  "Switch back to the previous tab",
];

export function ChatPanel({ conversationId, config }: { conversationId: Id<"conversations">; config: AppConfig | null }) {
  const saved = useQuery(api.messages.list, { conversationId });
  if (saved === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading conversation…
      </div>
    );
  }
  // useChat is seeded once from Convex; later updates stream in over the chat transport.
  return <Chat conversationId={conversationId} initialMessages={saved as UIMessage[]} config={config} />;
}

function Chat({
  conversationId,
  initialMessages,
  config,
}: {
  conversationId: Id<"conversations">;
  initialMessages: UIMessage[];
  config: AppConfig | null;
}) {
  const [input, setInput] = useState("");
  const [tab, setTab] = useState("chat");
  const requestStop = useMutation(api.agentRuns.requestStop);
  const session = useQuery(api.browserSessions.getForConversation, { conversationId });
  const actions = useQuery(api.actionLogs.listForConversation, { conversationId });
  const approvals = useQuery(api.approvals.listForConversation, { conversationId });
  const setPaused = useMutation(api.browserSessions.setPaused);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        // The server loads history from Convex; only send the new message.
        prepareSendMessagesRequest: ({ messages, id }) => ({ body: { id, message: messages[messages.length - 1] } }),
      }),
    [],
  );
  const { messages, sendMessage, status, stop, error, clearError } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
  });
  const busy = status === "submitted" || status === "streaming";

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, approvals?.length]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    clearError();
    void sendMessage({ text: t });
    setInput("");
    setTab("chat");
  };

  const stopAll = async () => {
    await stop();
    await requestStop({ conversationId }).catch(() => {});
  };

  const paused = session?.session.paused && ["running", "starting", "reconnecting"].includes(session.session.status);
  const running = actions?.some((a) => a.status === "executing");

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="flex h-full min-h-0 flex-col gap-0 border-l bg-background">
      <div className="flex h-10 shrink-0 items-center border-b px-2">
        <TabsList>
          <TabsTrigger value="chat">
            <MessageSquare /> Chat
          </TabsTrigger>
          <TabsTrigger value="timeline">
            <ListChecks /> Actions
            {running && <Loader2 className="animate-spin" />}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="chat" className="min-h-0 flex-1 data-[hidden]:hidden">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-4 p-4">
            {messages.length === 0 && (
              <div className="flex flex-col gap-3 py-6">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Bot className="size-4 text-primary" /> What should I do in the browser?
                </div>
                {config && !config.gatewayConfigured && (
                  <p className="text-xs text-muted-foreground">
                    No AI Gateway key is configured, so a keyword-based demo planner answers instead of an AI model.
                  </p>
                )}
                <div className="flex flex-col gap-2">
                  {SUGGESTIONS.map((s) => (
                    <Button key={s} variant="outline" className="h-auto justify-start py-2 text-left whitespace-normal" onClick={() => send(s)}>
                      {s}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <ChatMessage key={m.id} message={m} />
            ))}
            {status === "submitted" && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Thinking…
              </div>
            )}
            {approvals?.map((a) => (
              <ApprovalCard
                key={a._id}
                approval={a}
                conversationId={conversationId}
                onResult={(text) => send(text)}
              />
            ))}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error.message || "The assistant hit an error."}</AlertDescription>
              </Alert>
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
      </TabsContent>
      <TabsContent value="timeline" className="min-h-0 flex-1 data-[hidden]:hidden">
        <ActionTimeline actions={actions ?? []} />
      </TabsContent>

      <div className="shrink-0 border-t p-3">
        {paused && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-xs">
            <span>Assistant is paused.</span>
            <Button
              size="xs"
              onClick={async () => {
                await setPaused({ sessionId: session!.session._id, paused: false });
                send("Continue where you left off.");
              }}
            >
              Resume
            </Button>
          </div>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Ask the assistant to browse…"
            className="max-h-40 min-h-10 resize-none"
            rows={1}
            maxLength={4000}
          />
          {busy ? (
            <Button type="button" size="icon" variant="destructive" aria-label="Stop" onClick={stopAll}>
              <Square />
            </Button>
          ) : (
            <Button type="submit" size="icon" aria-label="Send" disabled={!input.trim()}>
              <ArrowUp />
            </Button>
          )}
        </form>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Page text is treated as untrusted. Consequential actions always ask for your approval.
        </p>
      </div>
    </Tabs>
  );
}

function ChatMessage({ message }: { message: UIMessage }) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
        {text}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          return part.text.trim() ? (
            <div key={i} className="max-w-full text-sm leading-relaxed whitespace-pre-wrap">
              <FormattedText text={part.text} />
            </div>
          ) : null;
        }
        if (part.type.startsWith("tool-")) {
          return <ToolChip key={i} part={part as Parameters<typeof ToolChip>[0]["part"]} />;
        }
        return null;
      })}
      {message.parts.length === 0 && <Badge variant="secondary">No response</Badge>}
    </div>
  );
}

/** Minimal formatting: **bold**, `code`, and > quotes. No HTML is rendered. */
function FormattedText({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => {
        const quote = line.startsWith("> ");
        const body = quote ? line.slice(2) : line;
        const pieces = body.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g).map((seg, j) => {
          if (seg.startsWith("**") && seg.endsWith("**")) return <strong key={j}>{seg.slice(2, -2)}</strong>;
          if (seg.startsWith("`") && seg.endsWith("`")) return <code key={j} className="rounded bg-muted px-1 text-xs">{seg.slice(1, -1)}</code>;
          if (seg.length > 2 && seg.startsWith("_") && seg.endsWith("_")) return <em key={j} className="text-muted-foreground">{seg.slice(1, -1)}</em>;
          return seg;
        });
        return (
          <span key={i} className={quote ? "block border-l-2 pl-2 text-muted-foreground" : "block min-h-[1em]"}>
            {pieces}
          </span>
        );
      })}
    </>
  );
}
