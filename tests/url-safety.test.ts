import { describe, expect, test } from "vitest";
import { checkNavigationUrl, isPrivateAddress, isReachedUrlAllowed } from "@/lib/browser/url-safety";
import { approvalReason } from "@/lib/browser/risk";
import type { ElementInfo } from "@/lib/browser/types";

const allow = ["example.com", "magicwebs.ai"];
const check = (url: string, list = allow) => checkNavigationUrl(url, list, { resolveDns: false });

describe("navigation URL checks", () => {
  test("allows https on allow-listed domains and subdomains, defaults to https", async () => {
    expect(await check("https://example.com/pricing")).toMatchObject({ ok: true });
    expect(await check("agent.magicwebs.ai")).toMatchObject({ ok: true, url: "https://agent.magicwebs.ai/" });
  });

  test.each([
    ["javascript:alert(1)", "UNSAFE_SCHEME"],
    ["file:///etc/passwd", "UNSAFE_SCHEME"],
    ["data:text/html,hi", "UNSAFE_SCHEME"],
    ["http://localhost:3000", "PRIVATE_NETWORK"],
    ["http://127.0.0.1", "PRIVATE_NETWORK"],
    ["http://169.254.169.254/latest/meta-data", "PRIVATE_NETWORK"],
    ["http://10.0.0.5", "PRIVATE_NETWORK"],
    ["http://[::1]/", "PRIVATE_NETWORK"],
    ["http://metadata.google.internal", "PRIVATE_NETWORK"],
    ["https://user:pass@example.com", "INVALID_URL"],
    ["https://example.com:8443", "PRIVATE_NETWORK"],
    ["https://notexample.com", "NOT_ALLOWED"],
    ["https://evil.com/?example.com", "NOT_ALLOWED"],
  ])("blocks %s", async (url, code) => {
    // Unsafe targets stay blocked even with the allowlist disabled ("*").
    const list = code === "NOT_ALLOWED" ? allow : ["*"];
    expect(await check(url, list)).toMatchObject({ ok: false, code });
  });

  test("private ranges", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::ffff:127.0.0.1", "fd00::1", "fe80::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  test("redirect revalidation rejects off-list or private final URLs", () => {
    expect(isReachedUrlAllowed("https://www.example.com/a", allow)).toBe(true);
    expect(isReachedUrlAllowed("https://phish.test/login", allow)).toBe(false);
    expect(isReachedUrlAllowed("http://192.168.0.1/admin", ["*"])).toBe(false);
    expect(isReachedUrlAllowed("about:blank", allow)).toBe(true);
  });
});

const el = (over: Partial<ElementInfo>): ElementInfo => ({
  ref: "o1-1", role: "button", name: "", tag: "button", inViewport: true, isSubmit: false, inForm: false, disabled: false, ...over,
});

describe("approval policy", () => {
  test("consequential clicks need approval", () => {
    expect(approvalReason("click", el({ name: "Send message", isSubmit: true, inForm: true }))).toBeTruthy();
    expect(approvalReason("click", el({ name: "Buy now" }))).toBeTruthy();
    expect(approvalReason("click", el({ name: "Delete record" }))).toBeTruthy();
    expect(approvalReason("click", el({ name: "Save changes" }))).toBeTruthy();
  });

  test("ordinary navigation and search do not", () => {
    expect(approvalReason("click", el({ role: "link", tag: "a", name: "Pricing" }))).toBeNull();
    expect(approvalReason("click", el({ name: "Search", isSubmit: true, inForm: true }))).toBeNull();
    expect(approvalReason("fill", el({ role: "searchbox", inputType: "search", name: "Search records" }), true)).toBeNull();
    expect(approvalReason("fill", el({ role: "textbox", name: "Message" }), false)).toBeNull();
  });

  test("pressing Enter in a non-search field needs approval", () => {
    expect(approvalReason("fill", el({ role: "textbox", name: "Email" }), true)).toBeTruthy();
  });
});
