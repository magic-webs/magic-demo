import { Suspense } from "react";
import { Workspace } from "@/components/workspace/workspace";

export default function Home() {
  return (
    <Suspense fallback={<div className="flex h-svh items-center justify-center text-sm text-muted-foreground">Loading workspace…</div>}>
      <Workspace />
    </Suspense>
  );
}
