import {
  convertToModelMessages,
  createIdGenerator,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  validateUIMessages,
  type StopCondition,
  type UIMessage,
} from "ai";
import { gateway } from "@ai-sdk/gateway";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getServerConfig } from "@/lib/server-config";
import { convexAs, convexErrorMessage, jsonError, requireToken } from "@/lib/convex-server";
import { AgentRuntime } from "@/lib/agent/runtime";
import { createBrowserTools, type BrowserTools } from "@/lib/agent/tools";
import { systemPrompt } from "@/lib/agent/prompt";
import { completeInterruptedToolCalls, sanitizeMessageForStorage } from "@/lib/agent/sanitize";
import { runDemoPlanner } from "@/lib/agent/demo-planner";

export const maxDuration = 300;

// Tool results that must end the plan: the model may only write a final reply.
const HALT_CODES = new Set(["APPROVAL_REQUIRED", "RUN_PAUSED", "RUN_STOPPED", "SUPERSEDED", "SESSION_EXPIRED"]);

function haltCode(steps: Array<{ toolResults: Array<{ output: unknown }> }>) {
  const last = steps.at(-1);
  for (const r of last?.toolResults ?? []) {
    const code = (r.output as { error?: { code?: string } } | undefined)?.error?.code;
    if (code && HALT_CODES.has(code)) return code;
  }
  return null;
}

export async function POST(req: Request) {
  const token = await requireToken();
  if (!token) return jsonError(401, "Sign in first.", "UNAUTHENTICATED");

  let body: { id?: unknown; message?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON.");
  }
  const message = body.message as UIMessage | undefined;
  if (typeof body.id !== "string" || !message || typeof message.id !== "string" || message.role !== "user" || !Array.isArray(message.parts)) {
    return jsonError(400, "Expected { id, message } with a user message.");
  }
  const userText = message.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();
  if (!userText || userText.length > 4000) return jsonError(400, "Message must be 1–4000 characters.");

  const conversationId = body.id as Id<"conversations">;
  const config = getServerConfig();
  const convex = convexAs(token);

  // Authorizes the conversation, saves the user message, takes the session lock.
  let start;
  try {
    start = await convex.mutation(api.agentRuns.start, {
      conversationId,
      userMessage: { id: message.id, parts: message.parts.filter((p) => p.type === "text") },
      model: config.gatewayConfigured ? config.model : "demo-planner",
      maxRunMs: config.limits.maxRunMs,
    });
  } catch (err) {
    const e = convexErrorMessage(err);
    return jsonError(e.code === "NOT_FOUND" ? 404 : 400, e.message, e.code);
  }
  if (start.duplicate) {
    return jsonError(409, "This message was already handled. Refresh to see the saved reply.", "DUPLICATE");
  }
  const runId = start.runId;

  const rt = await new AgentRuntime(convex, config, conversationId, runId).init();
  const tools = createBrowserTools(rt);

  const history = await convex.query(api.messages.list, { conversationId });
  let messages: UIMessage[];
  try {
    messages = await validateUIMessages<UIMessage>({
      messages: (history as UIMessage[]).map(completeInterruptedToolCalls),
      tools,
    });
  } catch {
    // Old/invalid stored parts: fall back to plain text history.
    messages = (history as UIMessage[]).map((m) => ({ ...m, parts: m.parts.filter((p) => p.type === "text") }));
  }

  // Cancel generation as soon as the user stops or a newer message supersedes this run.
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new Error("Run time limit reached")), config.limits.maxRunMs);
  const watcher = setInterval(async () => {
    try {
      const control = await convex.query(api.agentRuns.getControl, { runId });
      if (!control.canAct && control.reason !== "paused") abort.abort(new Error(`Run ${control.reason}`));
    } catch {
      // transient; the per-action gate still enforces control
    }
  }, 1500);
  const cleanup = () => {
    clearTimeout(deadline);
    clearInterval(watcher);
  };

  let finalStatus: "completed" | "paused" | "stopped" | "failed" = "completed";
  let finalError: string | undefined;

  const stream = createUIMessageStream<UIMessage>({
    originalMessages: messages,
    generateId: createIdGenerator({ prefix: "msg", size: 16 }),
    execute: async ({ writer }) => {
      if (!config.gatewayConfigured) {
        await runDemoPlanner({ rt, text: userText, writer, signal: abort.signal });
        return;
      }

      const tokenBudget: StopCondition<BrowserTools> = ({ steps }) =>
        steps.reduce((sum, s) => sum + (s.usage?.inputTokens ?? 0) + (s.usage?.outputTokens ?? 0), 0) >= config.limits.maxTotalTokens;

      const result = streamText({
        model: gateway(config.model),
        instructions: systemPrompt(config, { hasSession: Boolean(rt.sessionId) }),
        messages: await convertToModelMessages(messages, { tools }),
        tools,
        toolCallConcurrency: 1,
        stopWhen: [isStepCount(config.limits.maxSteps), tokenBudget],
        maxOutputTokens: config.limits.maxOutputTokens,
        timeout: { totalMs: config.limits.maxRunMs, toolMs: config.limits.toolTimeoutMs },
        abortSignal: abort.signal,
        prepareStep: ({ steps }) => {
          const code = haltCode(steps);
          if (code === "RUN_PAUSED") finalStatus = "paused";
          // After a halting result the model may only write its final reply.
          return code ? { toolChoice: "none" as const, activeTools: [] } : {};
        },
        onStepEnd: async (step) => {
          await convex
            .mutation(api.agentRuns.recordStep, {
              runId,
              inputTokens: step.usage?.inputTokens ?? 0,
              outputTokens: step.usage?.outputTokens ?? 0,
            })
            .catch(() => {});
        },
      });
      // Finish (and persist) even if the client disconnects, e.g. on refresh.
      result.consumeStream();
      writer.merge(toUIMessageStream({ stream: result.stream, sendStart: false }));
    },
    onError: (error) => {
      finalStatus = abort.signal.aborted ? "stopped" : "failed";
      finalError = error instanceof Error ? error.message : String(error);
      if (abort.signal.aborted) return "Stopped.";
      return "Something went wrong while generating the reply. Check the server logs and your AI Gateway setup.";
    },
    onEnd: async ({ responseMessage, isAborted }) => {
      cleanup();
      if (isAborted) finalStatus = "stopped";
      try {
        if (responseMessage.parts.length > 0) {
          await convex.mutation(api.messages.saveAssistantMessage, {
            conversationId,
            messageId: responseMessage.id,
            parts: sanitizeMessageForStorage(responseMessage).parts,
            runId,
          });
        }
      } finally {
        await convex.mutation(api.agentRuns.finish, { runId, status: finalStatus, error: finalError }).catch(() => {});
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
