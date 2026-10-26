import type { UIMessage } from "ai";

/**
 * Strip page content from tool outputs before they are persisted. Saved history
 * keeps action summaries and page title/URL, not the page text or element lists
 * (which are stale after the run anyway and may contain sensitive data).
 */
export function sanitizeMessageForStorage(input: UIMessage): UIMessage {
  const message = completeInterruptedToolCalls(input);
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (!part.type.startsWith("tool-") || !("output" in part) || !part.output || typeof part.output !== "object") {
        return part;
      }
      const output = { ...(part.output as Record<string, unknown>) };
      if (output.observation && typeof output.observation === "object") {
        const o = output.observation as { url?: string; title?: string };
        output.observation = { url: o.url, title: o.title, note: "The page was observed during that turn and the reply was based on it; the page text is just not kept in saved history. Observe again if you need current content." };
      }
      return { ...part, output } as typeof part;
    }),
  };
}

const FINISHED = new Set(["output-available", "output-error", "output-denied"]);

/**
 * A run that was stopped or superseded mid-tool leaves a tool call without a
 * result, and the model API rejects such histories. Mark those calls as
 * interrupted errors so the conversation can continue.
 */
export function completeInterruptedToolCalls(message: UIMessage): UIMessage {
  if (message.role !== "assistant") return message;
  let changed = false;
  const parts = message.parts.map((part) => {
    const p = part as { type: string; state?: string; input?: unknown };
    if ((p.type.startsWith("tool-") || p.type === "dynamic-tool") && p.state && !FINISHED.has(p.state)) {
      changed = true;
      return { ...part, state: "output-error", input: p.input ?? {}, errorText: "Interrupted before it finished (stopped or replaced by a newer instruction)." } as typeof part;
    }
    return part;
  });
  return changed ? { ...message, parts } : message;
}
