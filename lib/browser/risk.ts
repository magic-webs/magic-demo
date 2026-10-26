import type { ElementInfo } from "./types";

const CONSEQUENTIAL =
  /\b(buy|purchase|pay|checkout|place order|order now|subscribe|upgrade|delete|remove|send|submit|post|publish|confirm|transfer|book|reserve|unsubscribe|cancel (my )?(account|subscription|plan)|save changes|save settings|update (account|password|email|profile)|deactivate|close account|share|invite|apply|donate|sign up|register|create account)\b/i;

function isSearchLike(el: ElementInfo) {
  return (
    el.role === "searchbox" ||
    el.inputType === "search" ||
    /\b(search|find|filter|query|go)\b/i.test(el.name)
  );
}

/**
 * Decides whether an action needs explicit user approval. Returns the reason, or null.
 * Deliberately conservative: false positives cost one click, false negatives can cost money.
 */
export function approvalReason(kind: "click" | "fill", el: ElementInfo, submit = false): string | null {
  if (kind === "click") {
    if (el.isSubmit && !isSearchLike(el)) return `Clicking “${el.name || "submit"}” submits a form.`;
    if (CONSEQUENTIAL.test(el.name)) return `“${el.name}” looks like a consequential action.`;
    return null;
  }
  if (submit && !isSearchLike(el)) return `Pressing Enter in “${el.name || "this field"}” may submit a form.`;
  return null;
}
