import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { signLiveToken, verifyLiveToken } from "@/lib/browser/live-token";
import { checkNavigationUrl, matchesTrustedPrefix, trustedPrefixesFor } from "@/lib/browser/url-safety";
import { startEgressProxy } from "../worker/egress-proxy";

describe("trusted local sample site", () => {
  const trusted = trustedPrefixesFor("http://localhost:3000/sample");

  test("only /sample pages and /_next assets on the local origin are trusted", () => {
    expect(trusted).toEqual(["http://localhost:3000/sample", "http://localhost:3000/_next"]);
    expect(matchesTrustedPrefix(new URL("http://localhost:3000/sample/pricing"), trusted)).toBe(true);
    expect(matchesTrustedPrefix(new URL("http://localhost:3000/_next/static/x.js"), trusted)).toBe(true);
    expect(matchesTrustedPrefix(new URL("http://localhost:3000/api/config"), trusted)).toBe(false);
    expect(matchesTrustedPrefix(new URL("http://localhost:3000/samplex"), trusted)).toBe(false);
    expect(matchesTrustedPrefix(new URL("http://localhost:3001/sample"), trusted)).toBe(false);
  });

  test("public demo URLs get no exception", () => {
    expect(trustedPrefixesFor("https://my-app.vercel.app/sample")).toEqual([]);
  });

  test("navigation check honours the exception but still blocks the rest of localhost", async () => {
    expect(await checkNavigationUrl("http://localhost:3000/sample", [], { trusted, resolveDns: false })).toMatchObject({ ok: true });
    expect(await checkNavigationUrl("http://localhost:3000/api/chat", [], { trusted, resolveDns: false })).toMatchObject({ ok: false });
  });
});

describe("live-view tokens", () => {
  const secret = "s".repeat(40);
  test("valid, tampered, expired, wrong secret", () => {
    const claims = { sid: "abc", tab: "T1", input: false, exp: Date.now() + 60_000 };
    const token = signLiveToken(claims, secret);
    expect(verifyLiveToken(token, secret)).toEqual(claims);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, input: true })).toString("base64url");
    expect(verifyLiveToken(`${forged}.${sig}`, secret)).toBeNull();
    expect(verifyLiveToken(`${body}.${sig}`, "x".repeat(40))).toBeNull();
    expect(verifyLiveToken(signLiveToken({ ...claims, exp: Date.now() - 1 }, secret), secret)).toBeNull();
  });
});

describe("egress proxy", () => {
  let target: Server;
  let targetPort: number;
  let proxy: Awaited<ReturnType<typeof startEgressProxy>>;

  beforeAll(async () => {
    target = createServer((_req, res) => res.end("private data"));
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    targetPort = (target.address() as AddressInfo).port;
    proxy = await startEgressProxy([`http://127.0.0.1:${targetPort}/sample`]);
  });
  afterAll(async () => {
    await proxy.close();
    target.close();
  });

  const viaProxy = (url: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: proxy.port, method: "GET", path: url, headers: { Host: new URL(url).host } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });

  test("blocks private targets that aren't trusted", async () => {
    const r = await viaProxy(`http://127.0.0.1:${targetPort}/api/secret`);
    expect(r.status).toBe(403);
    expect(r.body).not.toContain("private data");
    expect((await viaProxy("http://169.254.169.254/latest/meta-data/")).status).toBe(403);
    expect((await viaProxy("http://localhost/")).status).toBe(403);
  });

  test("allows the trusted prefix on its private origin", async () => {
    const r = await viaProxy(`http://127.0.0.1:${targetPort}/sample/pricing`);
    expect(r).toEqual({ status: 200, body: "private data" });
  });

  test("blocks CONNECT tunnels to private hosts", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: proxy.port, method: "CONNECT", path: `127.0.0.1:443` });
      req.on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});
