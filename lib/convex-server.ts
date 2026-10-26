import "server-only";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { fetchMutation, fetchQuery } from "convex/nextjs";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";

/** Convex client bound to the signed-in user's token, for route handlers. */
export function convexAs(token: string) {
  return {
    query<Q extends FunctionReference<"query">>(ref: Q, args: FunctionArgs<Q>): Promise<FunctionReturnType<Q>> {
      return fetchQuery(ref, args, { token });
    },
    mutation<M extends FunctionReference<"mutation">>(ref: M, args: FunctionArgs<M>): Promise<FunctionReturnType<M>> {
      return fetchMutation(ref, args, { token });
    },
  };
}

export type ConvexAs = ReturnType<typeof convexAs>;

export async function requireToken() {
  const token = await convexAuthNextjsToken();
  return token ?? null;
}

export function convexErrorMessage(err: unknown) {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string; code?: string } | string;
    if (typeof data === "string") return { code: "ERROR", message: data };
    return { code: data.code ?? "ERROR", message: data.message ?? "Request failed." };
  }
  if (err instanceof Error) {
    // Convex server errors include a request id prefix; keep the readable part.
    const m = err.message.match(/Uncaught (?:Convex)?Error: (.*?)(?:\n|$)/);
    return { code: "ERROR", message: m?.[1] ?? err.message.split("\n")[0] };
  }
  return { code: "ERROR", message: "Unknown error." };
}

export function jsonError(status: number, message: string, code = "ERROR") {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}
