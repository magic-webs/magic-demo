import "server-only";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { approvalReason } from "@/lib/browser/risk";
import { BrowserActionError, type BrowserAdapter, type Observation } from "@/lib/browser/types";
import type { ActionResult, AgentRuntime } from "./runtime";

/** What the model sees from an observation. Page text is wrapped and marked untrusted. */
export function presentObservation(o: Observation) {
  return {
    tabId: o.tabId,
    url: o.url,
    title: o.title,
    scroll: o.scroll,
    elements: o.elements.map((e) => ({
      ref: e.ref,
      role: e.role,
      name: e.name,
      ...(e.href ? { href: e.href } : {}),
      ...(e.inputType ? { inputType: e.inputType } : {}),
      ...(e.disabled ? { disabled: true } : {}),
      inViewport: e.inViewport,
    })),
    visibleText: `<untrusted_page_content>\n${o.text}\n</untrusted_page_content>`,
  };
}

async function observeAfter(adapter: BrowserAdapter) {
  try {
    return presentObservation(await adapter.observe());
  } catch {
    return undefined;
  }
}

function describeTarget(adapter: BrowserAdapter, ref: string) {
  const el = adapter.describeRef(ref);
  return el ? `${el.role} “${el.name || "(unnamed)"}”` : `element ${ref}`;
}

export const browserActions = {
  async createSession(rt: AgentRuntime, key: string): Promise<ActionResult> {
    if (rt.sessionId) {
      return rt.perform({ tool: "createBrowserSession", label: "Use existing browser session", readOnly: true, idempotencyKey: key }, async (adapter) => {
        const tabs = await adapter.listTabs();
        return { ok: true, summary: `A browser session is already running with ${tabs.length} tab(s).`, tabs };
      });
    }
    return rt.perform(
      { tool: "createBrowserSession", label: rt.provider === "demo" ? "Start demo browser (simulated)" : "Start remote browser", readOnly: false, idempotencyKey: key, createSession: true },
      async (adapter) => {
        const tabs = await adapter.listTabs();
        return { ok: true, summary: rt.provider === "demo" ? "Demo browser (simulation) started." : "Remote browser session started.", tabs };
      },
    );
  },

  async endSession(rt: AgentRuntime, key: string): Promise<ActionResult> {
    if (!rt.sessionId) return { ok: true, summary: "No browser session was running." };
    const result = await rt.perform({ tool: "endBrowserSession", label: "End browser session", readOnly: false, idempotencyKey: key }, async () => ({
      ok: true,
      summary: "Browser session ended.",
    }));
    if (result.ok) await rt.endSession("Ended by assistant");
    return result;
  },

  observe(rt: AgentRuntime, key: string): Promise<ActionResult> {
    return rt.perform({ tool: "observePage", label: "Look at the page", readOnly: true, idempotencyKey: key }, async (adapter) => {
      const o = await adapter.observe();
      return {
        ok: true,
        summary: `Observed “${o.title}” (${o.elements.length} interactive elements, scroll ${o.scroll.y}/${o.scroll.maxY}px).`,
        page: { tabId: o.tabId, title: o.title, url: o.url },
        observation: presentObservation(o),
      };
    });
  },

  openUrl(rt: AgentRuntime, key: string, url: string): Promise<ActionResult> {
    return rt.perform({ tool: "openUrl", label: `Open ${url}`, readOnly: false, idempotencyKey: key, createSession: true }, async (adapter) => {
      const page = await adapter.openUrl(url);
      return { ok: true, summary: `Opened “${page.title}” at ${page.url}.`, page, observation: await observeAfter(adapter) };
    });
  },

  click(rt: AgentRuntime, key: string, input: { ref: string; why: string }, ctx: { runId: Id<"agentRuns"> | null }): Promise<ActionResult> {
    return rt.perform({ tool: "clickElement", label: `Click ${input.why}`, readOnly: false, idempotencyKey: key }, async (adapter, logId) => {
      const el = adapter.describeRef(input.ref);
      if (!el) throw new BrowserActionError("STALE_REF", `Element ref "${input.ref}" is stale or unknown. Call observePage again.`);
      if (el.disabled) throw new BrowserActionError("ELEMENT_NOT_FOUND", `${describeTarget(adapter, input.ref)} is disabled.`);
      const reason = approvalReason("click", el);
      if (reason) return requestApproval(rt, adapter, logId, ctx.runId, { kind: "click", elementRole: el.role, elementName: el.name }, reason);
      const page = await adapter.click(input.ref, { showCursor: rt.showCursor });
      return {
        ok: true,
        summary: `Clicked ${el.role} “${el.name}”. Now on “${page.title}”${page.openedTab ? " (opened in a new tab)" : ""}.`,
        page,
        observation: await observeAfter(adapter),
      };
    });
  },

  fill(rt: AgentRuntime, key: string, input: { ref: string; text: string; submit: boolean }, ctx: { runId: Id<"agentRuns"> | null }): Promise<ActionResult> {
    return rt.perform({ tool: "fillField", label: `Type into field${input.submit ? " and press Enter" : ""}`, readOnly: false, idempotencyKey: key }, async (adapter, logId) => {
      const el = adapter.describeRef(input.ref);
      if (!el) throw new BrowserActionError("STALE_REF", `Element ref "${input.ref}" is stale or unknown. Call observePage again.`);
      if (el.inputType === "password") throw new BrowserActionError("PASSWORD_FIELD", "I never type passwords. Ask the user to use “Take control” and sign in themselves.");
      const reason = approvalReason("fill", el, input.submit);
      if (reason) {
        return requestApproval(rt, adapter, logId, ctx.runId, { kind: "fill", elementRole: el.role, elementName: el.name, text: input.text, submit: input.submit }, reason);
      }
      const page = await adapter.fill(input.ref, input.text, { submit: input.submit, showCursor: rt.showCursor });
      return {
        ok: true,
        summary: `Typed into ${el.role} “${el.name}”${input.submit ? " and pressed Enter" : ""}.`,
        page,
        observation: input.submit ? await observeAfter(adapter) : undefined,
      };
    });
  },

  scroll(rt: AgentRuntime, key: string, input: { direction: "up" | "down"; amount: "small" | "page" | "top" | "bottom" }): Promise<ActionResult> {
    return rt.perform({ tool: "scrollPage", label: `Scroll ${input.amount === "top" || input.amount === "bottom" ? `to ${input.amount}` : input.direction}`, readOnly: false, idempotencyKey: key }, async (adapter) => {
      const r = await adapter.scroll(input.direction, input.amount);
      const moved = r.after - r.before;
      return {
        ok: moved !== 0,
        summary:
          moved !== 0
            ? `Scrolled ${moved > 0 ? "down" : "up"} ${Math.abs(moved)}px (now at ${r.after}/${r.maxY}px).`
            : `The viewport did not move (at ${r.after}/${r.maxY}px; probably already at the ${input.direction === "down" ? "bottom" : "top"}).`,
        page: { tabId: r.tabId, title: r.title, url: r.url },
        error: moved === 0 ? { code: "UNKNOWN", message: "Viewport unchanged.", recoverable: true } : undefined,
        observation: await observeAfter(adapter),
      };
    });
  },

  goBack(rt: AgentRuntime, key: string): Promise<ActionResult> {
    return rt.perform({ tool: "goBack", label: "Go back", readOnly: false, idempotencyKey: key }, async (adapter) => {
      const page = await adapter.goBack();
      return { ok: true, summary: `Went back. Now on “${page.title}”.`, page, observation: await observeAfter(adapter) };
    });
  },

  goForward(rt: AgentRuntime, key: string): Promise<ActionResult> {
    return rt.perform({ tool: "goForward", label: "Go forward", readOnly: false, idempotencyKey: key }, async (adapter) => {
      const page = await adapter.goForward();
      return { ok: true, summary: `Went forward. Now on “${page.title}”.`, page, observation: await observeAfter(adapter) };
    });
  },

  openTab(rt: AgentRuntime, key: string, url: string | null): Promise<ActionResult> {
    return rt.perform({ tool: "openTab", label: url ? `Open new tab: ${url}` : "Open new tab", readOnly: false, idempotencyKey: key, createSession: true }, async (adapter) => {
      const tabs = await adapter.listTabs();
      if (tabs.length >= rt.config.maxTabs) throw new BrowserActionError("TAB_LIMIT", `Tab limit (${rt.config.maxTabs}) reached. Close a tab first.`);
      const page = await adapter.openTab(url);
      return { ok: true, summary: `Opened a new tab${url ? ` with “${page.title}”` : ""}. It is now the active tab.`, page, observation: url ? await observeAfter(adapter) : undefined };
    });
  },

  listTabs(rt: AgentRuntime, key: string): Promise<ActionResult> {
    return rt.perform({ tool: "listTabs", label: "List tabs", readOnly: true, idempotencyKey: key }, async (adapter) => {
      const tabs = await adapter.listTabs();
      const active = adapter.activeTabId();
      return {
        ok: true,
        summary: `${tabs.length} tab(s) open.`,
        tabs: tabs.map((t, i) => ({ index: i, tabId: t.tabId, title: t.title, url: t.url, active: t.tabId === active })),
      };
    });
  },

  switchTab(rt: AgentRuntime, key: string, tabId: string): Promise<ActionResult> {
    return rt.perform({ tool: "switchTab", label: "Switch tab", readOnly: false, idempotencyKey: key }, async (adapter) => {
      const page = await adapter.switchTab(tabId);
      return { ok: true, summary: `Switched to tab “${page.title}”.`, page, observation: await observeAfter(adapter) };
    });
  },

  closeTab(rt: AgentRuntime, key: string, tabId: string): Promise<ActionResult> {
    return rt.perform({ tool: "closeTab", label: "Close tab", readOnly: false, idempotencyKey: key }, async (adapter) => {
      const page = await adapter.closeTab(tabId);
      return { ok: true, summary: `Closed the tab.${page ? ` Active tab is now “${page.title}”.` : ""}`, page: page ?? undefined };
    });
  },
};

async function requestApproval(
  rt: AgentRuntime,
  adapter: BrowserAdapter,
  logId: Id<"actionLogs">,
  runId: Id<"agentRuns"> | null,
  action: { kind: "click" | "fill"; elementRole: string; elementName: string; text?: string; submit?: boolean },
  reason: string,
): Promise<ActionResult> {
  if (!rt.sessionId) throw new BrowserActionError("NO_SESSION", "No session.");
  const tabs = await adapter.listTabs();
  const active = tabs.find((t) => t.tabId === adapter.activeTabId());
  if (!active) throw new BrowserActionError("TAB_NOT_FOUND", "Active tab not found.");
  const approvalId = await rt.convex.mutation(api.approvals.create, {
    conversationId: rt.conversationId,
    sessionId: rt.sessionId,
    runId: runId ?? undefined,
    actionLogId: logId,
    action: { ...action, tabId: active.tabId, pageUrl: active.url },
    reason,
  });
  return {
    ok: false,
    approvalId,
    summary: `Needs the user's approval: ${reason} Nothing was done yet. The user can approve or deny it in the app.`,
    page: { tabId: active.tabId, title: active.title, url: active.url },
    error: { code: "APPROVAL_REQUIRED", message: "Waiting for the user to approve in the UI. Do not retry.", recoverable: false },
  };
}

/**
 * Executes a user-approved action. Bound to the stored action: same tab, same
 * URL, and exactly one element with the same role and accessible name.
 */
export async function executeApproval(rt: AgentRuntime, approvalId: Id<"approvals">): Promise<ActionResult> {
  const approval = await rt.convex.mutation(api.approvals.claimForExecution, { approvalId });
  const a = approval.action;
  const result = await rt.perform(
    { tool: a.kind === "click" ? "clickElement" : "fillField", label: `Approved: ${a.kind} ${a.elementRole} “${a.elementName}”`, readOnly: false, idempotencyKey: `approval:${approvalId}` },
    async (adapter) => {
      if (adapter.activeTabId() !== a.tabId) await adapter.switchTab(a.tabId);
      const o = await adapter.observe();
      if (o.url !== a.pageUrl) {
        throw new BrowserActionError("STALE_REF", "The page changed since you approved, so nothing was done. Ask again.", false);
      }
      const matches = o.elements.filter((e) => e.role === a.elementRole && e.name === a.elementName);
      if (matches.length !== 1) {
        throw new BrowserActionError("ELEMENT_NOT_FOUND", `Couldn't uniquely find ${a.elementRole} “${a.elementName}” any more, so nothing was done.`, false);
      }
      const ref = matches[0].ref;
      const page =
        a.kind === "click"
          ? await adapter.click(ref, { showCursor: rt.showCursor })
          : await adapter.fill(ref, a.text ?? "", { submit: a.submit ?? false, showCursor: rt.showCursor });
      return { ok: true, summary: `Approved action done: ${a.kind} ${a.elementRole} “${a.elementName}”. Now on “${page.title}”.`, page };
    },
  );
  await rt.convex.mutation(api.approvals.markExecuted, { approvalId, ok: result.ok, summary: result.summary });
  return result;
}
