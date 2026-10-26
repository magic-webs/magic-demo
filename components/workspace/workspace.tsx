"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LogOut, Menu, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useIsMobile } from "@/hooks/use-mobile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";
import { BrowserPanel } from "./browser-panel";
import { ChatPanel } from "./chat-panel";
import { ConversationList } from "./conversation-list";
import { SettingsDialog } from "./settings-dialog";
import type { AppConfig } from "./types";

export function Workspace() {
  const router = useRouter();
  const params = useSearchParams();
  const isMobile = useIsMobile();
  const { signOut } = useAuthActions();
  const conversations = useQuery(api.conversations.list);
  const createConversation = useMutation(api.conversations.create);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileHistory, setMobileHistory] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const creating = useRef(false);

  const selected = params.get("c") as Id<"conversations"> | null;
  const conversationId = conversations?.some((c) => c._id === selected) ? selected : (conversations?.[0]?._id ?? null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  // First visit: make sure there is a conversation to talk in.
  useEffect(() => {
    if (conversations && conversations.length === 0 && !creating.current) {
      creating.current = true;
      createConversation({})
        .then((id) => router.replace(`/?c=${id}`))
        .finally(() => (creating.current = false));
    }
  }, [conversations, createConversation, router]);

  const select = (id: Id<"conversations">) => {
    router.replace(`/?c=${id}`);
    setMobileHistory(false);
  };
  const newChat = async () => select(await createConversation({}));

  const sidebar = (
    <ConversationList conversations={conversations ?? []} activeId={conversationId} onSelect={select} onNew={newChat} />
  );

  const browser = conversationId ? <BrowserPanel conversationId={conversationId} config={config} /> : null;
  const chat = conversationId ? <ChatPanel key={conversationId} conversationId={conversationId} config={config} /> : null;

  return (
    <div className="flex h-svh w-full overflow-hidden bg-background">
      {!isMobile && sidebarOpen && <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar">{sidebar}</aside>}
      <Sheet open={mobileHistory} onOpenChange={setMobileHistory}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">Conversations</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Toggle conversation history"
                  onClick={() => (isMobile ? setMobileHistory(true) : setSidebarOpen((v) => !v))}
                />
              }
            >
              {isMobile ? <Menu /> : sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
            </TooltipTrigger>
            <TooltipContent>Conversation history</TooltipContent>
          </Tooltip>
          <span className="truncate text-sm font-medium">
            {conversations?.find((c) => c._id === conversationId)?.title ?? "Browser assistant"}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {config && (
              <>
                <Badge variant={config.browserMode === "demo" ? "secondary" : "outline"} className="hidden sm:inline-flex">
                  {config.browserMode === "demo"
                    ? "Demo browser (simulated)"
                    : config.browserMode === "selfhosted"
                      ? "Remote browser: self-hosted"
                      : "Remote browser: Browserbase"}
                </Badge>
                <Badge variant={config.gatewayConfigured ? "outline" : "secondary"} className="hidden md:inline-flex">
                  {config.gatewayConfigured ? `AI: ${config.model}` : "AI: demo planner (no model)"}
                </Badge>
              </>
            )}
            <ThemeToggle />
            <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
              <Settings />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Sign out" onClick={() => void signOut().then(() => router.replace("/signin"))}>
              <LogOut />
            </Button>
          </div>
        </header>

        {isMobile ? (
          <Tabs defaultValue="chat" className="flex min-h-0 flex-1 flex-col gap-0">
            <TabsList className="mx-2 mt-2 w-[calc(100%-1rem)]">
              <TabsTrigger value="browser">Browser</TabsTrigger>
              <TabsTrigger value="chat">Chat</TabsTrigger>
            </TabsList>
            {/* keepMounted so the live view and chat stream survive tab switches */}
            <TabsContent value="browser" keepMounted className="min-h-0 flex-1 data-[hidden]:hidden">
              {browser}
            </TabsContent>
            <TabsContent value="chat" keepMounted className="min-h-0 flex-1 data-[hidden]:hidden">
              {chat}
            </TabsContent>
          </Tabs>
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
            <ResizablePanel defaultSize="64" minSize="35">
              {browser}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="36" minSize={320}>
              {chat}
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} config={config} />
    </div>
  );
}
