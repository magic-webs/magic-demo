"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Globe,
  Hand,
  Loader2,
  MonitorPlay,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { postJson, type AppConfig, type SessionView } from "./types";

function IconButton({ label, children, ...props }: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} {...props} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function BrowserPanel({ conversationId, config }: { conversationId: Id<"conversations">; config: AppConfig | null }) {
  const data = useQuery(api.browserSessions.getForConversation, { conversationId });
  const setPaused = useMutation(api.browserSessions.setPaused);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [takeover, setTakeover] = useState(false);

  const session = data?.session;
  const live = session && ["starting", "running", "reconnecting"].includes(session.status);
  const tabs = live ? (data?.tabs ?? []) : [];
  const activeTab = tabs.find((t) => t.tabId === session?.activeTabId) ?? tabs[0];

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const control = (body: Record<string, unknown>) =>
    run(String(body.op), async () => {
      const r = await postJson("/api/browser/control", { conversationId, ...body });
      if (!r.ok) throw new Error(r.summary ?? r.error?.message ?? "Action failed");
    });

  const start = () => run("start", () => postJson("/api/browser/session", { conversationId }));
  const stop = () =>
    run("stop", async () => {
      setTakeover(false);
      await postJson("/api/browser/session", { conversationId }, "DELETE");
    });

  const toggleTakeover = async () => {
    if (!session) return;
    if (!takeover) {
      // The assistant must not act while the human is in control.
      await setPaused({ sessionId: session._id, paused: true });
      setTakeover(true);
    } else {
      setTakeover(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/30">
      {/* Tab strip */}
      <div className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b bg-muted/60 px-2 pt-1.5">
        {tabs.map((tab) => {
          const active = tab.tabId === activeTab?.tabId;
          return (
            <div
              key={tab.tabId}
              className={cn(
                "group flex h-8 max-w-52 min-w-28 items-center gap-1.5 rounded-t-lg border border-b-0 px-2 text-xs",
                active ? "bg-background font-medium" : "border-transparent text-muted-foreground hover:bg-background/60",
              )}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5"
                onClick={() => !active && control({ op: "switchTab", tabId: tab.tabId })}
                title={tab.url}
              >
                {active && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Active tab" />}
                <Globe className="size-3.5 shrink-0" />
                <span className="truncate">{tab.title || tab.url}</span>
              </button>
              {tabs.length > 1 && (
                <button
                  className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-muted"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => control({ op: "closeTab", tabId: tab.tabId })}
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          );
        })}
        {live && (
          <IconButton label="New tab" className="mb-0.5" onClick={() => control({ op: "newTab", url: null })} disabled={!!busy}>
            <Plus />
          </IconButton>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b bg-background px-2 py-1.5">
        <IconButton label="Back" disabled={!live || !!busy} onClick={() => control({ op: "back" })}>
          <ArrowLeft />
        </IconButton>
        <IconButton label="Forward" disabled={!live || !!busy} onClick={() => control({ op: "forward" })}>
          <ArrowRight />
        </IconButton>
        <AddressBar key={activeTab?.url ?? "none"} url={activeTab?.url ?? ""} disabled={!!busy} onGo={(url) => control({ op: "navigate", url })} />
        <div className="flex items-center gap-1">
          {!live ? (
            <Button size="sm" onClick={start} disabled={!!busy || !config}>
              {busy === "start" ? <Loader2 className="animate-spin" /> : <Play />} Start session
            </Button>
          ) : (
            <>
              {session.paused ? (
                <Button size="sm" variant="secondary" onClick={() => { setTakeover(false); void setPaused({ sessionId: session._id, paused: false }); }}>
                  <Play /> Resume
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setPaused({ sessionId: session._id, paused: true })}>
                  <Pause /> Pause
                </Button>
              )}
              {session.provider !== "demo" && (
                <Button size="sm" variant={takeover ? "default" : "outline"} onClick={toggleTakeover}>
                  <Hand /> {takeover ? "Done" : "Take control"}
                </Button>
              )}
              <Button size="sm" variant="destructive" onClick={stop} disabled={busy === "stop"}>
                {busy === "stop" ? <Loader2 className="animate-spin" /> : <Square />} Stop
              </Button>
            </>
          )}
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="m-2 w-auto">
          <AlertTriangle />
          <AlertTitle>Browser action failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Viewport */}
      <div className="relative min-h-0 flex-1">
        {data === undefined ? (
          <CenterMessage icon={<Loader2 className="animate-spin" />} title="Loading…" />
        ) : !session || !live ? (
          <NoSession session={session ?? null} config={config} onStart={start} starting={busy === "start"} />
        ) : session.status === "starting" ? (
          <CenterMessage icon={<Loader2 className="animate-spin" />} title={session.provider === "demo" ? "Starting demo browser…" : "Starting remote browser…"} />
        ) : session.provider === "demo" ? (
          <DemoView tab={activeTab ?? null} />
        ) : (
          <LiveView sessionId={session._id} tabsKey={tabs.map((t) => t.tabId).join(",")} activeTabId={activeTab?.tabId ?? null} interactive={takeover} />
        )}
        {live && session.status === "reconnecting" && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70">
            <Badge variant="secondary"><RefreshCw className="animate-spin" /> Reconnecting…</Badge>
          </div>
        )}
        {live && session.paused && !takeover && (
          <Badge className="absolute top-2 left-1/2 -translate-x-1/2" variant="secondary">
            <Pause /> Assistant paused
          </Badge>
        )}
        {takeover && (
          <Badge className="absolute top-2 left-1/2 -translate-x-1/2">
            <Hand /> You are in control — the assistant is paused
          </Badge>
        )}
      </div>
    </div>
  );
}

function AddressBar({ url, disabled, onGo }: { url: string; disabled: boolean; onGo: (url: string) => void }) {
  const [value, setValue] = useState(url);
  return (
    <form
      className="min-w-40 flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onGo(value.trim());
      }}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Enter a URL (allowed domains only)"
        aria-label="Address"
        className="h-8 rounded-full font-mono text-xs"
        disabled={disabled}
      />
    </form>
  );
}

function CenterMessage({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
        {icon}
        <p className="font-medium text-foreground">{title}</p>
        {children}
      </div>
    </div>
  );
}

function NoSession({
  session,
  config,
  onStart,
  starting,
}: {
  session: SessionView["session"] | null;
  config: AppConfig | null;
  onStart: () => void;
  starting: boolean;
}) {
  const ended = session && ["expired", "error", "ended"].includes(session.status);
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">{ended && session.status !== "ended" ? <AlertTriangle /> : <MonitorPlay />}</EmptyMedia>
        <EmptyTitle>
          {!ended ? "No browser running" : session.status === "expired" ? "Session expired" : session.status === "error" ? "Browser error" : "Session ended"}
        </EmptyTitle>
        <EmptyDescription>
          {ended && session.status !== "ended"
            ? `${session.endReason ?? ""}${session.errorMessage ? ` — ${session.errorMessage}` : ""}. Start a new session to continue.`
            : config?.browserMode === "demo"
              ? "Demo mode: a simulated browser that can only show the built-in sample site. Start the browser worker (see README) for a real browser."
              : "Start a remote browser, or just ask the assistant to open a website."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onStart} disabled={starting || !config}>
          {starting ? <Loader2 className="animate-spin" /> : <Play />} {ended ? "Start new session" : "Start session"}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** Live view of the remote tab: our worker's screencast stream, or Browserbase's iframe. */
function LiveView({
  sessionId,
  tabsKey,
  activeTabId,
  interactive,
}: {
  sessionId: Id<"browserSessions">;
  tabsKey: string;
  activeTabId: string | null;
  interactive: boolean;
}) {
  const [pages, setPages] = useState<LivePage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/browser/live?sessionId=${sessionId}&interactive=${interactive ? 1 : 0}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d?.error?.message ?? "Live view unavailable");
        return d as { pages: LivePage[] };
      })
      .then((d) => {
        if (cancelled) return;
        setError(null);
        setPages(d.pages);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // Re-fetch when tabs open/close (each tab has its own live URL) or takeover toggles.
  }, [sessionId, tabsKey, reloadKey, interactive]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data === "browserbase-disconnected") setDisconnected(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (error) {
    return (
      <CenterMessage icon={<AlertTriangle className="text-destructive" />} title="Live view could not start">
        <p className="max-w-sm">{error}</p>
        <Button size="sm" variant="outline" onClick={() => { setError(null); setReloadKey((k) => k + 1); }}>
          <RefreshCw /> Retry
        </Button>
      </CenterMessage>
    );
  }
  if (disconnected) {
    return (
      <CenterMessage icon={<AlertTriangle />} title="Live view disconnected">
        <p className="max-w-sm">The remote browser stream ended. If the session expired, stop it and start a new one.</p>
        <Button size="sm" variant="outline" onClick={() => { setDisconnected(false); setReloadKey((k) => k + 1); }}>
          <RefreshCw /> Reconnect view
        </Button>
      </CenterMessage>
    );
  }
  const page = pages?.find((p) => p.tabId === activeTabId) ?? pages?.[0];
  if (!pages) return <CenterMessage icon={<Loader2 className="animate-spin" />} title="Connecting live view…" />;
  if (!page?.liveUrl) return <CenterMessage icon={<AlertTriangle />} title="No live view for this tab yet" />;

  if (page.kind === "stream") {
    return (
      <StreamView
        key={`${page.tabId}-${reloadKey}-${interactive}`}
        url={page.liveUrl}
        interactive={interactive}
        onClosed={() => setDisconnected(true)}
      />
    );
  }
  return (
    <iframe
      key={`${page.tabId}-${reloadKey}`}
      src={page.liveUrl}
      title="Remote browser live view"
      sandbox="allow-same-origin allow-scripts"
      allow="clipboard-read; clipboard-write"
      referrerPolicy="no-referrer"
      className={cn("size-full border-0 bg-white", !interactive && "pointer-events-none")}
    />
  );
}

type LivePage = { tabId: string; kind: "iframe" | "stream"; liveUrl: string | null };

/**
 * Renders the self-hosted worker's CDP screencast (JPEG frames over WebSocket).
 * With a takeover token, mouse/keyboard events are forwarded to the real tab.
 */
function StreamView({ url, interactive, onClosed }: { url: string; interactive: boolean; onClosed: () => void }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const frameSize = useRef({ w: 1280, h: 800 });
  const [live, setLive] = useState(false);
  const onClosedRef = useRef(onClosed);
  useEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;
    let gotFrame = false;
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; data?: string; w?: number; h?: number };
      if (msg.type !== "frame" || !msg.data || !imgRef.current) return;
      imgRef.current.src = `data:image/jpeg;base64,${msg.data}`;
      frameSize.current = { w: msg.w ?? 1280, h: msg.h ?? 800 };
      if (!gotFrame) {
        gotFrame = true;
        setLive(true);
      }
    };
    ws.onclose = (event) => {
      if (event.code !== 1000) onClosedRef.current();
    };
    return () => {
      // Our own cleanup (unmount, tab switch, dev double-mount) is not a disconnect.
      ws.onclose = null;
      ws.onmessage = null;
      ws.close(1000);
    };
  }, [url]);

  const send = (msg: object) => {
    if (interactive && wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(msg));
  };
  const point = (e: React.MouseEvent | React.WheelEvent) => {
    const rect = imgRef.current!.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * frameSize.current.w),
      y: Math.round(((e.clientY - rect.top) / rect.height) * frameSize.current.h),
    };
  };
  const button = (b: number) => (b === 2 ? "right" : b === 1 ? "middle" : "left");

  return (
    <div
      className={cn("relative flex size-full items-start justify-center overflow-hidden bg-neutral-100 outline-none dark:bg-neutral-900", interactive && "cursor-default")}
      tabIndex={interactive ? 0 : -1}
      onKeyDown={(e) => {
        if (!interactive) return;
        e.preventDefault();
        send({ type: "key", action: "down", key: e.key, code: e.code, text: e.key.length === 1 ? e.key : e.key === "Enter" ? "\r" : undefined });
      }}
      onKeyUp={(e) => interactive && send({ type: "key", action: "up", key: e.key, code: e.code })}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- frames are data: URLs updated in place */}
      <img
        ref={imgRef}
        alt="Remote browser live view"
        draggable={false}
        className={cn("max-h-full max-w-full select-none", !interactive && "pointer-events-none")}
        onMouseDown={(e) => {
          (e.currentTarget.parentElement as HTMLElement).focus();
          send({ type: "mouse", action: "down", button: button(e.button), ...point(e) });
        }}
        onMouseUp={(e) => send({ type: "mouse", action: "up", button: button(e.button), ...point(e) })}
        onMouseMove={(e) => interactive && e.buttons === 0 && send({ type: "mouse", action: "move", ...point(e) })}
        onWheel={(e) => send({ type: "wheel", dx: e.deltaX, dy: e.deltaY, ...point(e) })}
        onContextMenu={(e) => interactive && e.preventDefault()}
      />
      {!live && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Badge variant="secondary"><Loader2 className="animate-spin" /> Waiting for the first frame…</Badge>
        </div>
      )}
    </div>
  );
}

/** Demo mode: same-origin sample site in an iframe, driven by simulated state. Clearly labelled. */
function DemoView({ tab }: { tab: { tabId: string; url: string; scrollY: number; title: string } | null }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: DEMO_WIDTH, height: 800 });
  const isSample = tab?.url.startsWith("/sample");

  // Render at the same 1280px viewport the remote browser uses, scaled to fit.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setBox({ width: entry.contentRect.width, height: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !tab) return;
    const apply = () => frame.contentWindow?.scrollTo({ top: tab.scrollY, behavior: "smooth" });
    apply();
    frame.addEventListener("load", apply);
    return () => frame.removeEventListener("load", apply);
  }, [tab]);

  // Hidden (e.g. inactive mobile tab) panels measure 0; avoid a zero scale.
  const scale = box.width > 0 ? Math.min(1, box.width / DEMO_WIDTH) : 1;
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-center gap-2 bg-amber-100 px-3 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        <AlertTriangle className="size-3.5" />
        Demo mode — simulated browser on the built-in sample site. This is not a remote browser.
      </div>
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden bg-white">
        {tab && isSample ? (
          <iframe
            ref={frameRef}
            src={tab.url}
            title="Demo browser (simulated)"
            className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
            style={{ width: DEMO_WIDTH, height: box.height / scale, transform: `scale(${scale})` }}
          />
        ) : (
          <CenterMessage icon={<Globe />} title="Blank tab">
            <p>Ask: “Open the demo website”.</p>
          </CenterMessage>
        )}
      </div>
    </div>
  );
}

const DEMO_WIDTH = 1280;
