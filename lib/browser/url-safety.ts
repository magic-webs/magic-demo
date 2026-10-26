import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type UrlCheck =
  | { ok: true; url: string; host: string }
  | { ok: false; code: "INVALID_URL" | "UNSAFE_SCHEME" | "PRIVATE_NETWORK" | "NOT_ALLOWED" | "DNS_FAILED"; message: string };

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);

/** True for loopback, private, link-local (incl. 169.254.169.254 metadata), CGNAT, multicast, etc. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === "::" || v6 === "::1") return true;
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6) || v6.startsWith("64:ff9b:") || v6.startsWith("2001:db8");
  }
  return true;
}

export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  if (allowlist.includes("*")) return true;
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowlist.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Parse loosely-typed input ("example.com/pricing") into a URL, defaulting to https. */
export function normalizeUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/**
 * Validates a navigation target. This is one layer only: the remote browser's
 * own `allowedDomains` setting and post-navigation checks catch redirects.
 * String/DNS validation alone cannot fully prevent SSRF (e.g. DNS rebinding).
 */
export async function checkNavigationUrl(
  input: string,
  allowlist: string[],
  opts: { resolveDns?: boolean; trusted?: string[] } = {},
): Promise<UrlCheck> {
  const url = normalizeUrl(input);
  if (!url) return { ok: false, code: "INVALID_URL", message: "That doesn't look like a valid URL." };
  if (matchesTrustedPrefix(url, opts.trusted ?? [])) return { ok: true, url: url.toString(), host: url.hostname };
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, code: "UNSAFE_SCHEME", message: `Only http(s) URLs are allowed, not ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, code: "INVALID_URL", message: "URLs with embedded credentials are not allowed." };
  }
  if (url.port && url.port !== "443" && url.port !== "80") {
    return { ok: false, code: "PRIVATE_NETWORK", message: "Non-standard ports are blocked." };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || (!host.includes(".") && !isIP(host))) {
    return { ok: false, code: "PRIVATE_NETWORK", message: "Local and internal hosts are blocked." };
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      return { ok: false, code: "PRIVATE_NETWORK", message: "Private network addresses are blocked." };
    }
  }
  if (!hostMatchesAllowlist(host, allowlist)) {
    return {
      ok: false,
      code: "NOT_ALLOWED",
      message: `${host} is not on the allowed-domain list. Add it in Settings (or ALLOWED_DOMAINS) and start a new session.`,
    };
  }
  if (opts.resolveDns !== false && !isIP(host)) {
    try {
      const addresses = await lookup(host, { all: true });
      if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
        return { ok: false, code: "PRIVATE_NETWORK", message: `${host} resolves to a private address.` };
      }
    } catch {
      return { ok: false, code: "DNS_FAILED", message: `Could not resolve ${host}.` };
    }
  }
  return { ok: true, url: url.toString(), host };
}

/** Synchronous check for URLs the browser already reached (redirect revalidation). */
export function isReachedUrlAllowed(rawUrl: string, allowlist: string[], trusted: string[] = []): boolean {
  if (rawUrl === "about:blank" || rawUrl.startsWith("chrome-error://")) return true;
  const url = normalizeUrl(rawUrl);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return false;
  if (matchesTrustedPrefix(url, trusted)) return true;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host)) return false;
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return false;
  return hostMatchesAllowlist(host, allowlist);
}

/**
 * Exact origin + path-prefix exceptions, used only for the app's own local
 * sample site (e.g. http://localhost:3000/sample). Everything else on that
 * origin, such as /api, stays blocked.
 */
export function matchesTrustedPrefix(url: URL, prefixes: string[]): boolean {
  return prefixes.some((prefix) => {
    const p = new URL(prefix);
    if (p.origin !== url.origin) return false;
    const base = p.pathname.replace(/\/$/, "");
    return url.pathname === base || url.pathname.startsWith(`${base}/`);
  });
}

/** Trusted prefixes for a demo site that lives on a local/private host. */
export function trustedPrefixesFor(demoSiteUrl: string | null | undefined): string[] {
  if (!demoSiteUrl) return [];
  const url = normalizeUrl(demoSiteUrl);
  if (!url) return [];
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host.endsWith(".localhost") || (isIP(host) > 0 && isPrivateAddress(host));
  if (!local) return [];
  return [`${url.origin}${url.pathname.replace(/\/$/, "") || "/sample"}`, `${url.origin}/_next`];
}
