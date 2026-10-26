import "server-only";
import type { UIMessageStreamWriter } from "ai";
import { browserActions } from "./actions";
import type { ActionResult, AgentRuntime } from "./runtime";

/**
 * DEMO PLANNER — used only when no AI Gateway credentials are configured.
 * It is a keyword script, not an AI model, and every reply says so. It drives
 * the same tool layer so the UI, timeline, approvals and tabs can be tried out.
 */

type Step =
  | { tool: "openUrl"; input: { url: string } }
  | { tool: "openTab"; input: { url: string | null } }
  | { tool: "clickByName"; input: { pattern: RegExp; label: string } }
  | { tool: "scrollPage"; input: { direction: "up" | "down"; amount: "small" | "page" | "top" | "bottom" } }
  | { tool: "goBack"; input: Record<string, never> }
  | { tool: "previousTab"; input: Record<string, never> }
  | { tool: "search"; input: { text: string } }
  | { tool: "observePage"; input: Record<string, never> };

function plan(text: string, demoUrl: string): Step[] {
  const t = text.toLowerCase();
  const found: Array<{ at: number; step: Step }> = [];
  const add = (re: RegExp, make: (m: RegExpMatchArray) => Step | null) => {
    for (const m of t.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) {
      const step = make(m);
      if (step) found.push({ at: m.index ?? 0, step });
    }
  };
  const urlIn = (s: string) => s.match(/https?:\/\/[^\s"')]+/)?.[0] ?? null;

  add(/new tab/, () => ({ tool: "openTab", input: { url: urlIn(text) ?? (/(demo|sample)/.test(t) ? demoUrl : null) } }));
  if (!/new tab/.test(t)) {
    add(/https?:\/\/[^\s"')]+/, (m) => ({ tool: "openUrl", input: { url: text.slice(m.index!, m.index! + m[0].length) } }));
    add(/(open|go to|visit|kholo|khol)[^.]*?(demo|sample)/, () => ({ tool: "openUrl", input: { url: demoUrl } }));
  }
  add(/pricing/, () => ({ tool: "clickByName", input: { pattern: /^pricing$/i, label: "the Pricing link" } }));
  add(/\brecords?\b/, () => ({ tool: "clickByName", input: { pattern: /^records$/i, label: "the Records link" } }));
  add(/contact/, () => ({ tool: "clickByName", input: { pattern: /^contact$/i, label: "the Contact link" } }));
  add(/search(?: for)? ["“]?([a-z0-9 -]{2,30})["”]?/, (m) => ({ tool: "search", input: { text: m[1].trim() } }));
  add(/open (aster|bluefin|cedar|dhara|ember|fable|granite|harbor|indigo|juniper)/, (m) => ({
    tool: "clickByName",
    input: { pattern: new RegExp(`^open ${m[1]}`, "i"), label: `the ${m[1]} record` },
  }));
  add(/scroll (down|up|to (?:the )?(?:bottom|top))/, (m) => {
    const w = m[1];
    if (w.includes("bottom")) return { tool: "scrollPage", input: { direction: "down", amount: "bottom" } };
    if (w.includes("top")) return { tool: "scrollPage", input: { direction: "up", amount: "top" } };
    return { tool: "scrollPage", input: { direction: w as "up" | "down", amount: "page" } };
  });
  add(/switch back(?: to (?:the )?previous tab)?|previous tab|pichle tab/, () => ({ tool: "previousTab", input: {} }));
  add(/(submit|send) (the )?(form|message)/, () => ({ tool: "clickByName", input: { pattern: /^send message$/i, label: "the Send message button" } }));
  add(/\bgo back\b/, () => ({ tool: "goBack", input: {} }));

  found.sort((a, b) => a.at - b.at);
  const steps = found.map((f) => f.step);
  if (steps.length === 0 || /(explain|describe|what do you see|batao|summari[sz]e)/.test(t)) {
    steps.push({ tool: "observePage", input: {} });
  }
  return steps;
}

export async function runDemoPlanner(opts: {
  rt: AgentRuntime;
  text: string;
  writer: UIMessageStreamWriter;
  signal: AbortSignal;
}) {
  const { rt, writer } = opts;
  const demoUrl = rt.provider === "demo" ? "/sample" : (rt.config.demoSiteUrl ?? "/sample");
  const steps = plan(opts.text, demoUrl);
  const results: ActionResult[] = [];
  let n = 0;

  const call = async (toolName: string, input: unknown, run: (key: string) => Promise<ActionResult>) => {
    const toolCallId = `demo_${Date.now().toString(36)}_${n++}`;
    writer.write({ type: "start-step" });
    writer.write({ type: "tool-input-available", toolCallId, toolName, input });
    const result = await run(`${rt.runId}:${toolCallId}`);
    writer.write({ type: "tool-output-available", toolCallId, output: result });
    writer.write({ type: "finish-step" });
    results.push(result);
    return result;
  };

  for (const step of steps) {
    if (opts.signal.aborted) break;
    let result: ActionResult;
    switch (step.tool) {
      case "openUrl":
        result = await call("openUrl", step.input, (k) => browserActions.openUrl(rt, k, step.input.url));
        break;
      case "openTab":
        result = await call("openTab", step.input, (k) => browserActions.openTab(rt, k, step.input.url));
        break;
      case "scrollPage":
        result = await call("scrollPage", step.input, (k) => browserActions.scroll(rt, k, step.input));
        break;
      case "goBack":
        result = await call("goBack", {}, (k) => browserActions.goBack(rt, k));
        break;
      case "observePage":
        result = await call("observePage", {}, (k) => browserActions.observe(rt, k));
        break;
      case "previousTab": {
        const list = await call("listTabs", {}, (k) => browserActions.listTabs(rt, k));
        const tabs = (list.tabs as Array<{ tabId: string; active: boolean }> | undefined) ?? [];
        const idx = tabs.findIndex((t) => t.active);
        const prev = tabs[idx - 1] ?? tabs.find((t) => !t.active);
        result = prev
          ? await call("switchTab", { tabId: prev.tabId }, (k) => browserActions.switchTab(rt, k, prev.tabId))
          : { ok: false, summary: "There is no other tab to switch to." };
        break;
      }
      case "clickByName":
      case "search": {
        const obs = await call("observePage", {}, (k) => browserActions.observe(rt, k));
        const elements = ((obs.observation as { elements?: Array<{ ref: string; role: string; name: string }> } | undefined)?.elements) ?? [];
        if (step.tool === "search") {
          const box = elements.find((e) => e.role === "searchbox" || /search/i.test(e.name));
          result = box
            ? await call("fillField", { ref: box.ref, text: step.input.text, submit: true }, (k) =>
                browserActions.fill(rt, k, { ref: box.ref, text: step.input.text, submit: true }, { runId: rt.runId }),
              )
            : { ok: false, summary: "I couldn't find a search box on this page." };
        } else {
          const pattern = step.input.pattern;
          const target = elements.find((e) => pattern.test(e.name));
          result = target
            ? await call("clickElement", { ref: target.ref, why: step.input.label }, (k) =>
                browserActions.click(rt, k, { ref: target.ref, why: step.input.label }, { runId: rt.runId }),
              )
            : { ok: false, summary: `I couldn't find ${step.input.label} on this page.` };
        }
        break;
      }
    }
    if (!result.ok && result.error && !result.error.recoverable) break;
  }

  const last = [...results].reverse().find((r) => r.observation) as { observation?: { title?: string; visibleText?: string } } | undefined;
  const failed = results.filter((r) => !r.ok).map((r) => `✗ ${r.summary}`);
  const seen = last?.observation?.visibleText
    ?.replace(/<\/?untrusted_page_content>/g, "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, 8)
    .map((l) => `> ${l}`)
    .join("\n");

  const text = [
    "_Demo planner (no AI model configured): these steps came from keyword rules, not an AI._",
    "",
    failed.length ? failed.join("\n") : `Done: ${results.length} action(s) completed and verified (see the steps above).`,
    ...(seen ? ["", `**What's visible on “${last?.observation?.title}”:**`, seen] : []),
  ].join("\n");
  const id = `demo_text_${Date.now().toString(36)}`;
  writer.write({ type: "start-step" });
  writer.write({ type: "text-start", id });
  writer.write({ type: "text-delta", id, delta: text });
  writer.write({ type: "text-end", id });
  writer.write({ type: "finish-step" });
}
