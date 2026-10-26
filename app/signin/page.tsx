"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SignInPage() {
  const { signIn } = useAuthActions();
  const router = useRouter();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Bot className="size-5" />
          </div>
          <CardTitle>{flow === "signIn" ? "Sign in" : "Create your account"}</CardTitle>
          <CardDescription>Your conversations and browser sessions are private to your account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setPending(true);
              setError(null);
              const formData = new FormData(event.currentTarget);
              formData.set("flow", flow);
              try {
                await signIn("password", formData);
                router.replace("/");
              } catch {
                setError(
                  flow === "signIn"
                    ? "Could not sign in. Check your email and password, or create an account."
                    : "Could not create the account. Use a valid email and a password of at least 8 characters.",
                );
              } finally {
                setPending(false);
              }
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                minLength={8}
                autoComplete={flow === "signIn" ? "current-password" : "new-password"}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              {flow === "signIn" ? "Sign in" : "Sign up"}
            </Button>
            <Button
              type="button"
              variant="link"
              onClick={() => {
                setFlow(flow === "signIn" ? "signUp" : "signIn");
                setError(null);
              }}
            >
              {flow === "signIn" ? "New here? Create an account" : "Already have an account? Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
