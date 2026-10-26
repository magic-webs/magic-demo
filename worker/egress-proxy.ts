import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect, isIP, type AddressInfo, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { isPrivateAddress, matchesTrustedPrefix } from "../lib/browser/url-safety";

/**
 * Egress proxy that every byte from a session's Chrome goes through
 * (`--proxy-server` + `--proxy-bypass-list=<-loopback>`). Unlike request
 * interception it sees every hop, including redirects, sub-resources, workers
 * and WebSockets. It resolves DNS itself and connects to the exact IP it
 * checked, so DNS rebinding can't swap in a private address afterwards.
 */

const BLOCKED_NAMES = /^(localhost|metadata|metadata\.google\.internal|instance-data)$|\.(localhost|local|internal|lan|home|corp|intranet)$/i;
const ALLOWED_PORTS = new Set([80, 443]);

type Target = { ok: true; ip: string } | { ok: false; reason: string };

async function resolvePublic(host: string, port: number): Promise<Target> {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!ALLOWED_PORTS.has(port)) return { ok: false, reason: "port not allowed" };
  if (BLOCKED_NAMES.test(h)) return { ok: false, reason: "local hostname" };
  if (isIP(h)) return isPrivateAddress(h) ? { ok: false, reason: "private address" } : { ok: true, ip: h };
  try {
    const addrs = await lookup(h, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) return { ok: false, reason: "resolves to a private address" };
    return { ok: true, ip: addrs[0].address };
  } catch {
    return { ok: false, reason: "DNS lookup failed" };
  }
}

/** Trusted prefixes (the local sample site) may reach their private origin, path-checked. */
async function resolveHttp(url: URL, trusted: string[]): Promise<Target> {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (matchesTrustedPrefix(url, trusted)) {
    const h = url.hostname.replace(/^\[|\]$/g, "");
    const ip = isIP(h) ? h : (await lookup(h).catch(() => null))?.address;
    return ip ? { ok: true, ip } : { ok: false, reason: "DNS lookup failed" };
  }
  return resolvePublic(url.hostname, port);
}

function deny(socket: Socket, reason: string) {
  socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBlocked by browser worker: ${reason}\n`);
}

export async function startEgressProxy(trusted: string[]): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    // Plain-HTTP requests arrive with an absolute URL.
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const target = await resolveHttp(url, trusted);
    if (!target.ok) {
      res.writeHead(403, { "Content-Type": "text/plain" }).end(`Blocked by browser worker: ${target.reason}\n`);
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = httpRequest(
      { host: target.ip, port: Number(url.port || 80), method: req.method, path: url.pathname + url.search, headers, setHost: false },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => res.headersSent ? res.destroy() : res.writeHead(502).end());
    req.pipe(upstream);
  });

  // HTTPS / WSS tunnels: only host:port is visible here.
  server.on("connect", async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const [host, portStr] = (req.url ?? "").split(/:(?=\d+$)/);
    const target = await resolvePublic(host ?? "", Number(portStr));
    if (!target.ok) return deny(socket, target.reason);
    const upstream = netConnect(Number(portStr), target.ip, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  // Plain ws:// upgrades (e.g. the local sample site's dev hot-reload socket).
  server.on("upgrade", async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      return deny(socket, "bad request");
    }
    const target = await resolveHttp(url, trusted);
    if (!target.ok) return deny(socket, target.reason);
    const upstream = netConnect(Number(url.port || 80), target.ip, () => {
      const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (!/^proxy-/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
