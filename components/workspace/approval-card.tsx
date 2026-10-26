"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { Check, Hand, Loader2, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { postJson, type ApprovalView } from "./types";

/**
 * Approval is bound to the exact stored action. Approving runs that action
 * through trusted server code; the model can never approve on its own.
 */
export function ApprovalCard({
  approval,
  conversationId,
  onResult,
}: {
  approval: ApprovalView;
  conversationId: Id<"conversations">;
  onResult: (text: string) => void;
}) {
  const decide = useMutation(api.approvals.decide);
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const a = approval.action;
  const what =
    a.kind === "click"
      ? `Click ${a.elementRole} “${a.elementName}”`
      : `Type “${a.text ?? ""}” into “${a.elementName}”${a.submit ? " and press Enter" : ""}`;

  const approve = async () => {
    setPending("approve");
    setError(null);
    try {
      await decide({ approvalId: approval._id, decision: "approve" });
      const r = await postJson<{ ok: boolean; summary: string }>("/api/browser/control", {
        op: "executeApproval",
        conversationId,
        approvalId: approval._id,
      });
      onResult(`I approved: ${what}. Result: ${r.summary} Please continue.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const deny = async () => {
    setPending("deny");
    try {
      await decide({ approvalId: approval._id, decision: "deny" });
      onResult(`I denied: ${what}. Don't do that.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200">
        <Hand className="size-4" /> Approval needed
      </div>
      <p className="mt-1">{what}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{approval.reason}</p>
      <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={a.pageUrl}>on {a.pageUrl}</p>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {approval.status === "pending" ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={approve} disabled={!!pending}>
            {pending === "approve" ? <Loader2 className="animate-spin" /> : <Check />} Approve once
          </Button>
          <Button size="sm" variant="outline" onClick={deny} disabled={!!pending}>
            {pending === "deny" ? <Loader2 className="animate-spin" /> : <X />} Deny
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">Status: {approval.status}</p>
      )}
    </div>
  );
}
