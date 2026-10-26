"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { AppConfig } from "./types";

export function SettingsDialog({
  open,
  onOpenChange,
  config,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: AppConfig | null;
}) {
  const settings = useQuery(api.browserSessions.getSettings);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Allowed domains apply to newly started browser sessions.</DialogDescription>
        </DialogHeader>
        {settings && open && (
          <SettingsForm initial={settings} config={config} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SettingsForm({
  initial,
  config,
  onDone,
}: {
  initial: { extraAllowedDomains: string[]; showCursor: boolean };
  config: AppConfig | null;
  onDone: () => void;
}) {
  const update = useMutation(api.browserSessions.updateSettings);
  const [domains, setDomains] = useState(initial.extraAllowedDomains.join("\n"));
  const [showCursor, setShowCursor] = useState(initial.showCursor);
  const [saving, setSaving] = useState(false);

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="domains">Extra allowed domains (one per line)</Label>
          <Textarea id="domains" rows={5} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="docs.example.com" />
          {config && (
            <p className="text-xs text-muted-foreground">
              Always allowed (server config): {config.allowedDomains.join(", ")}. Subdomains are included.
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="cursor" className="flex flex-col items-start gap-1">
            Show assistant cursor
            <span className="text-xs font-normal text-muted-foreground">
              Draws a labelled pointer inside the remote page before clicks. It is only a visual overlay; Playwright performs the real click.
            </span>
          </Label>
          <Switch id="cursor" checked={showCursor} onCheckedChange={setShowCursor} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await update({ extraAllowedDomains: domains.split(/[\s,]+/).filter(Boolean), showCursor });
              onDone();
            } finally {
              setSaving(false);
            }
          }}
        >
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
