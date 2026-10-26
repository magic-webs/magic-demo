import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived capability tokens for the self-hosted worker's live view.
 * Minted by the Next.js server after an ownership check, verified by the worker.
 * Shared by both sides; uses only node:crypto.
 */
export type LiveTokenClaims = {
  /** Worker session id. */
  sid: string;
  /** Tab (CDP target id) the viewer may watch. */
  tab: string;
  /** Whether mouse/keyboard input is allowed (human takeover). */
  input: boolean;
  /** Expiry, ms since epoch. */
  exp: number;
};

const b64url = (buf: Buffer) => buf.toString("base64url");

export function signLiveToken(claims: LiveTokenClaims, secret: string) {
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyLiveToken(token: string, secret: string): LiveTokenClaims | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as LiveTokenClaims;
    if (typeof claims.exp !== "number" || claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}
