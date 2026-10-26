import { describe, expect, test } from "vitest";
import { DemoAdapter } from "@/lib/browser/demo-adapter";
import type { UIMessage } from "ai";
import { completeInterruptedToolCalls, sanitizeMessageForStorage } from "@/lib/agent/sanitize";

async function refFor(adapter: DemoAdapter, pattern: RegExp) {
  const o = await adapter.observe();
  const el = o.elements.find((e) => pattern.test(e.name));
  if (!el) throw new Error(`no element ${pattern}`);
  return el.ref;
}

describe("demo adapter (simulated browser for demo mode)", () => {
  test("open → pricing → scroll changes the visible viewport", async () => {
    const a = new DemoAdapter([], undefined);
    await a.openUrl("/sample");
    await a.click(await refFor(a, /^Pricing$/));
    expect((await a.observe()).url).toBe("/sample/pricing");
    const before = await a.observe();
    const r = await a.scroll("down", "page");
    expect(r.after).toBeGreaterThan(r.before);
    const after = await a.observe();
    expect(after.text).not.toEqual(before.text);
  });

  test("refs go stale after navigation", async () => {
    const a = new DemoAdapter([], undefined);
    await a.openUrl("/sample");
    const pricing = await refFor(a, /^Pricing$/);
    await a.openUrl("/sample/records");
    await expect(a.click(pricing)).rejects.toMatchObject({ code: "STALE_REF" });
  });

  test("new tab keeps the old tab; switching changes the active tab", async () => {
    const a = new DemoAdapter([], undefined);
    await a.openUrl("/sample/pricing");
    const firstTab = a.activeTabId()!;
    await a.openTab("/sample/records");
    const tabs = await a.listTabs();
    expect(tabs).toHaveLength(2);
    expect(tabs[0].url).toBe("/sample/pricing");
    await a.switchTab(firstTab);
    expect((await a.observe()).url).toBe("/sample/pricing");
  });

  test("opening a record shows its details", async () => {
    const a = new DemoAdapter([], undefined);
    await a.openUrl("/sample/records");
    await a.click(await refFor(a, /^Open Bluefin/));
    const o = await a.observe();
    expect(o.url).toContain("id=R-1002");
    expect(o.text).toContain("Arjun Iyer");
  });

  test("demo mode refuses real websites instead of pretending", async () => {
    const a = new DemoAdapter([], undefined);
    await expect(a.openUrl("https://youtube.com")).rejects.toMatchObject({ code: "DEMO_UNSUPPORTED" });
  });
});


describe("saved history", () => {
  const msg = {
    id: "m1",
    role: "assistant",
    parts: [
      { type: "tool-openUrl", toolCallId: "a", state: "output-available", input: { url: "x" }, output: { ok: true, observation: { url: "u", title: "t", visibleText: "secret page text" } } },
      { type: "tool-clickElement", toolCallId: "b", state: "input-available", input: { ref: "o1-1", why: "x" } },
    ],
  } as unknown as UIMessage;

  test("interrupted tool calls become errors so the next turn isn't rejected", () => {
    const fixed = completeInterruptedToolCalls(msg).parts[1] as { state: string; errorText: string };
    expect(fixed.state).toBe("output-error");
    expect(fixed.errorText).toMatch(/Interrupted/);
  });

  test("page text is not persisted", () => {
    expect(JSON.stringify(sanitizeMessageForStorage(msg))).not.toContain("secret page text");
  });
});
