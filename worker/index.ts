/**
 * Self-hosted remote browser worker.
 *
 *   POST   /sessions            create an isolated Chromium (own process + temp profile)
 *   GET    /sessions/:id        status
 *   GET    /sessions/:id/pages  tabs (CDP target ids, url, title)
 *   DELETE /sessions/:id        release (kills the process, deletes the profile)
 *   WS     /cdp/:id             CDP proxy for the app server's Playwright   (Bearer secret)
 *   WS     /live/:id?tab&token  screencast + optional human input          (signed, short-lived token)
 *
 * Only the Next.js server holds BROWSER_WORKER_SECRET. Browsers' viewers get a
 * per-tab token minted after a Convex ownership check.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { verifyLiveToken } from "../lib/browser/live-token";
import {
  createSession,
  findPage,
  getSession,
  listPages,
  releaseAll,
  releaseSession,
  resolveChrome,
  sessionCount,
  startReaper,
  touch,
  type WorkerSession,
} from "./sessions";

const SECRET = process.env.BROWSER_WORKER_SECRET ?? "";
if (SECRET.length < 32) {
  console.error("BROWSER_WORKER_SECRET must be set (at least 32 characters).");
  process.exit(1);
}
const PORT = Number(process.env.WORKER_PORT ?? 8787);
const HOST = process.env.WORKER_HOST ?? "127.0.0.1";
const MAX_SESSIONS = Number(process.env.WORKER_MAX_SESSIONS ?? 3);
const IDLE_MS = Number(process.env.WORKER_IDLE_SECONDS ?? 600) * 1000;
const MAX_TIMEOUT_SEC = 21_600;

function authorized(req: IncomingMessage) {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.replace(/^Bearer /, ""));
  const expected = Buffer.from(SECRET);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

const stringArray = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 200) : []);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://worker");
  if (url.pathname === "/health") return json(res, 200, { ok: true, sessions: sessionCount() });
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" });

  try {
    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = (await readJson(req)) as { allowedDomains?: unknown; trustedPrefixes?: unknown; timeoutSec?: unknown };
      const timeoutSec = Math.min(Math.max(Number(body.timeoutSec) || 900, 60), MAX_TIMEOUT_SEC);
      const s = await createSession({
        allowlist: stringArray(body.allowedDomains),
        trusted: stringArray(body.trustedPrefixes),
        timeoutSec,
        maxSessions: MAX_SESSIONS,
      });
      return json(res, 201, { id: s.id, expiresAt: s.expiresAt });
    }
    const m = url.pathname.match(/^\/sessions\/([\w-]+)(\/pages)?$/);
    if (m) {
      const s = getSession(m[1]);
      if (req.method === "DELETE") return json(res, 200, { released: await releaseSession(m[1]) });
      if (!s) return json(res, 404, { status: "ENDED" });
      if (m[2]) return json(res, 200, { pages: await listPages(s) });
      return json(res, 200, { status: "RUNNING", expiresAt: s.expiresAt });
    }
    return json(res, 404, { error: "not found" });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return json(res, status, { error: err instanceof Error ? err.message : "error" });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://worker");
  const cdp = url.pathname.match(/^\/cdp\/([\w-]+)$/);
  const live = url.pathname.match(/^\/live\/([\w-]+)$/);
  const reject = (code: number) => {
    socket.write(`HTTP/1.1 ${code} Unauthorized\r\n\r\n`);
    socket.destroy();
  };
  if (cdp) {
    const s = getSession(cdp[1]);
    if (!authorized(req) || !s) return reject(401);
    return wss.handleUpgrade(req, socket, head, (ws) => proxyCdp(ws, s));
  }
  if (live) {
    const claims = verifyLiveToken(url.searchParams.get("token") ?? "", SECRET);
    const s = getSession(live[1]);
    if (!claims || claims.sid !== live[1] || !s) return reject(401);
    return wss.handleUpgrade(req, socket, head, (ws) => void streamLive(ws, s, claims.tab, claims.input));
  }
  reject(404);
});

/** Pipes CDP messages between the app's Playwright and the local Chrome. */
function proxyCdp(client: WebSocket, s: WorkerSession) {
  const upstream = new WebSocket(s.wsEndpoint, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  const pending: Array<{ data: RawData; binary: boolean }> = [];
  upstream.on("open", () => {
    for (const p of pending.splice(0)) upstream.send(p.data, { binary: p.binary });
  });
  client.on("message", (data, binary) => {
    touch(s);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    else pending.push({ data, binary });
  });
  upstream.on("message", (data, binary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
  });
  const close = () => {
    client.close();
    upstream.close();
  };
  client.on("close", close);
  upstream.on("close", close);
  client.on("error", close);
  upstream.on("error", close);
}

type InputMessage =
  | { type: "mouse"; action: "down" | "up" | "move"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; action: "down" | "up"; key: string; code: string; text?: string };

/** Streams JPEG frames of one tab; forwards input only if the token allows it. */
async function streamLive(ws: WebSocket, s: WorkerSession, tabId: string, allowInput: boolean) {
  const page = await findPage(s, tabId);
  if (!page) {
    ws.close(4404, "tab not found");
    return;
  }
  const cdp = await s.context.newCDPSession(page);
  let closed = false;

  cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    // Drop frames for slow viewers instead of buffering without bound.
    if (closed || ws.bufferedAmount > 2 * 1024 * 1024) return;
    ws.send(JSON.stringify({ type: "frame", data: frame.data, w: frame.metadata.deviceWidth, h: frame.metadata.deviceHeight }));
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });

  ws.on("message", async (raw) => {
    if (!allowInput) return;
    let msg: InputMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    touch(s);
    try {
      if (msg.type === "mouse") {
        const type = msg.action === "down" ? "mousePressed" : msg.action === "up" ? "mouseReleased" : "mouseMoved";
        await cdp.send("Input.dispatchMouseEvent", {
          type,
          x: msg.x,
          y: msg.y,
          button: msg.action === "move" ? "none" : (msg.button ?? "left"),
          clickCount: msg.action === "move" ? 0 : 1,
        });
      } else if (msg.type === "wheel") {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: msg.x, y: msg.y, deltaX: msg.dx, deltaY: msg.dy });
      } else if (msg.type === "key") {
        await cdp.send("Input.dispatchKeyEvent", {
          type: msg.action === "down" ? (msg.text ? "keyDown" : "rawKeyDown") : "keyUp",
          key: msg.key,
          code: msg.code,
          text: msg.action === "down" ? msg.text : undefined,
          windowsVirtualKeyCode: msg.key.length === 1 ? msg.key.toUpperCase().charCodeAt(0) : undefined,
        });
      }
    } catch {
      // ignore input errors (e.g. page navigating)
    }
  });

  const stop = () => {
    if (closed) return;
    closed = true;
    void cdp.send("Page.stopScreencast").catch(() => {});
    void cdp.detach().catch(() => {});
  };
  ws.on("close", stop);
  ws.on("error", stop);
  page.once("close", () => ws.close(4410, "tab closed"));
}

const reaper = startReaper(IDLE_MS);
server.listen(PORT, HOST, () => {
  console.log(`Browser worker listening on http://${HOST}:${PORT} (chrome: ${resolveChrome()})`);
});

async function shutdown() {
  clearInterval(reaper);
  await releaseAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
