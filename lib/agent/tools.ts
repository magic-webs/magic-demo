import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { browserActions } from "./actions";
import type { AgentRuntime } from "./runtime";

const ref = z
  .string()
  .regex(/^[a-z][a-z0-9]{1,8}-\d{1,4}$/, "Use a ref from the latest observation, e.g. o3kd-12")
  .describe("Element ref from the most recent observation. Refs expire after any navigation or page change.");

/**
 * The only capabilities the model gets. No arbitrary JS, shell, or code execution.
 * Each call is keyed by its tool-call id so retries never repeat an action.
 */
export function createBrowserTools(rt: AgentRuntime) {
  const key = (toolCallId: string) => `${rt.runId ?? "user"}:${toolCallId}`;
  const ctx = { runId: rt.runId };

  return {
    createBrowserSession: tool({
      description: "Start the remote browser session for this conversation (no-op if one is running). openUrl also starts one automatically.",
      inputSchema: z.object({}),
      execute: (_input, { toolCallId }) => browserActions.createSession(rt, key(toolCallId)),
    }),
    observePage: tool({
      description:
        "Look at the active tab: title, URL, scroll position, interactive elements with short-lived refs, and visible text. Call before clicking or typing if you don't have a fresh observation.",
      inputSchema: z.object({}),
      execute: (_input, { toolCallId }) => browserActions.observe(rt, key(toolCallId)),
    }),
    openUrl: tool({
      description: "Navigate the active tab to a URL (https preferred). Only allow-listed domains work.",
      inputSchema: z.object({ url: z.string().min(1).max(2000).describe("Absolute URL, or a bare domain like example.com") }),
      execute: ({ url }, { toolCallId }) => browserActions.openUrl(rt, key(toolCallId), url),
    }),
    clickElement: tool({
      description:
        "Click one element chosen from the latest observation. Consequential clicks (submit, buy, delete, send, settings) are held for the user's approval automatically.",
      inputSchema: z.object({
        ref,
        why: z
          .string()
          .min(1)
          .max(300)
          .transform((w) => w.slice(0, 80))
          .describe("Short label (a few words) for the timeline, e.g. 'the Pricing link'"),
      }),
      execute: (input, { toolCallId }) => browserActions.click(rt, key(toolCallId), input, ctx),
    }),
    fillField: tool({
      description: "Type text into a text field from the latest observation. Never use for passwords or one-time codes.",
      inputSchema: z.object({
        ref,
        text: z.string().max(500),
        submit: z.boolean().default(false).describe("Press Enter afterwards (e.g. to run a search)"),
      }),
      execute: (input, { toolCallId }) => browserActions.fill(rt, key(toolCallId), input, ctx),
    }),
    scrollPage: tool({
      description: "Scroll the active tab and report how far the viewport actually moved.",
      inputSchema: z.object({
        direction: z.enum(["up", "down"]),
        amount: z.enum(["small", "page", "top", "bottom"]).default("page"),
      }),
      execute: (input, { toolCallId }) => browserActions.scroll(rt, key(toolCallId), input),
    }),
    goBack: tool({
      description: "Go back in the active tab's history.",
      inputSchema: z.object({}),
      execute: (_input, { toolCallId }) => browserActions.goBack(rt, key(toolCallId)),
    }),
    goForward: tool({
      description: "Go forward in the active tab's history.",
      inputSchema: z.object({}),
      execute: (_input, { toolCallId }) => browserActions.goForward(rt, key(toolCallId)),
    }),
    openTab: tool({
      description: "Open a new tab in the same remote browser (optionally at a URL) and make it active. Existing tabs are kept.",
      inputSchema: z.object({ url: z.string().max(2000).nullable().default(null) }),
      execute: ({ url }, { toolCallId }) => browserActions.openTab(rt, key(toolCallId), url),
    }),
    listTabs: tool({
      description: "List open tabs with ids, titles, URLs and which one is active.",
      inputSchema: z.object({}),
      execute: (_input, { toolCallId }) => browserActions.listTabs(rt, key(toolCallId)),
    }),
    switchTab: tool({
      description: "Make another tab active (use a tabId from listTabs). The live view follows the active tab.",
      inputSchema: z.object({ tabId: z.string().min(1).max(100) }),
      execute: ({ tabId }, { toolCallId }) => browserActions.switchTab(rt, key(toolCallId), tabId),
    }),
    closeTab: tool({
      description: "Close a tab by id. The last tab can't be closed.",
      inputSchema: z.object({ tabId: z.string().min(1).max(100) }),
      execute: ({ tabId }, { toolCallId }) => browserActions.closeTab(rt, key(toolCallId), tabId),
    }),
    endBrowserSession: tool({
      description: "End the remote browser session. Only when the user asks to finish or stop browsing.",
      inputSchema: z.object({}),
      execute: (_input, { toolCallId }) => browserActions.endSession(rt, key(toolCallId)),
    }),
  };
}

export type BrowserTools = ReturnType<typeof createBrowserTools>;
