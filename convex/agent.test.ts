/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const as = async () => {
    const { userId, sessionId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 });
      return { userId, sessionId };
    });
    return t.withIdentity({ subject: `${userId}|${sessionId}`, tokenIdentifier: `test|${userId}` });
  };
  return { t, alice: await as(), bob: await as() };
}

type Client = Awaited<ReturnType<typeof setup>>["alice"];

async function conversationWithSession(user: Client) {
  const conversationId = await user.mutation(api.conversations.create, {});
  const { sessionId } = await user.mutation(api.browserSessions.createPending, {
    conversationId,
    provider: "demo",
    allowedDomains: ["example.com"],
    timeoutSec: 600,
  });
  await user.mutation(api.browserSessions.markRunning, { sessionId, providerSessionId: "demo" });
  return { conversationId, sessionId };
}

const startRun = (user: Client, conversationId: Id<"conversations">, id: string) =>
  user.mutation(api.agentRuns.start, {
    conversationId,
    userMessage: { id, parts: [{ type: "text", text: "open example.com" }] },
    model: "test",
    maxRunMs: 60_000,
  });

describe("ownership", () => {
  test("another user cannot read or act on my conversation", async () => {
    const { alice, bob } = await setup();
    const { conversationId, sessionId } = await conversationWithSession(alice);
    await expect(bob.query(api.messages.list, { conversationId })).rejects.toThrow();
    await expect(bob.query(api.browserSessions.getForConversation, { conversationId })).rejects.toThrow();
    await expect(bob.query(api.browserSessions.getInternalView, { sessionId })).rejects.toThrow();
    await expect(bob.mutation(api.browserSessions.setPaused, { sessionId, paused: true })).rejects.toThrow();
    await expect(startRun(bob, conversationId, "u1")).rejects.toThrow();
    expect(await bob.query(api.conversations.list, {})).toHaveLength(0);
  });

  test("signed-out callers are rejected", async () => {
    const { t, alice } = await setup();
    const { conversationId } = await conversationWithSession(alice);
    await expect(t.query(api.messages.list, { conversationId })).rejects.toThrow(/Sign in/);
  });
});

describe("run control gate", () => {
  test("stop prevents queued actions from executing", async () => {
    const { alice } = await setup();
    const { conversationId, sessionId } = await conversationWithSession(alice);
    const { runId } = await startRun(alice, conversationId, "u1");
    const first = await alice.mutation(api.actionLogs.begin, { conversationId, runId, sessionId, idempotencyKey: "k1", tool: "openUrl", label: "Open", readOnly: false });
    expect(first.allowed).toBe(true);
    await alice.mutation(api.agentRuns.requestStop, { conversationId });
    const queued = await alice.mutation(api.actionLogs.begin, { conversationId, runId, sessionId, idempotencyKey: "k2", tool: "clickElement", label: "Click", readOnly: false });
    expect(queued).toMatchObject({ allowed: false, reason: "stopped" });
  });

  test("pause blocks browser-changing actions but allows read-only observation", async () => {
    const { alice } = await setup();
    const { conversationId, sessionId } = await conversationWithSession(alice);
    const { runId } = await startRun(alice, conversationId, "u1");
    await alice.mutation(api.browserSessions.setPaused, { sessionId, paused: true });
    const click = await alice.mutation(api.actionLogs.begin, { conversationId, runId, sessionId, idempotencyKey: "k1", tool: "clickElement", label: "Click", readOnly: false });
    expect(click).toMatchObject({ allowed: false, reason: "paused" });
    const observe = await alice.mutation(api.actionLogs.begin, { conversationId, runId, sessionId, idempotencyKey: "k2", tool: "observePage", label: "Look", readOnly: true });
    expect(observe.allowed).toBe(true);
  });

  test("a new instruction supersedes the old run and takes the session lock", async () => {
    const { alice } = await setup();
    const { conversationId, sessionId } = await conversationWithSession(alice);
    const old = await startRun(alice, conversationId, "u1");
    const next = await startRun(alice, conversationId, "u2");
    const gate = await alice.mutation(api.actionLogs.begin, { conversationId, runId: old.runId, sessionId, idempotencyKey: "k1", tool: "openUrl", label: "Open", readOnly: false });
    expect(gate).toMatchObject({ allowed: false, reason: "superseded" });
    const control = await alice.query(api.agentRuns.getControl, { runId: next.runId });
    expect(control.canAct).toBe(true);
  });

  test("the same tool call is never executed twice (idempotency key)", async () => {
    const { alice } = await setup();
    const { conversationId, sessionId } = await conversationWithSession(alice);
    const { runId } = await startRun(alice, conversationId, "u1");
    const args = { conversationId, runId, sessionId, idempotencyKey: "same", tool: "openUrl", label: "Open", readOnly: false };
    expect((await alice.mutation(api.actionLogs.begin, args)).allowed).toBe(true);
    expect(await alice.mutation(api.actionLogs.begin, args)).toMatchObject({ allowed: false, reason: "duplicate" });
  });

  test("re-sending an already answered message does not start a second run", async () => {
    const { alice } = await setup();
    const { conversationId } = await conversationWithSession(alice);
    const first = await startRun(alice, conversationId, "u1");
    await alice.mutation(api.agentRuns.finish, { runId: first.runId, status: "completed" });
    const again = await startRun(alice, conversationId, "u1");
    expect(again.duplicate).toBe(true);
    const messages = await alice.query(api.messages.list, { conversationId });
    expect(messages.filter((m) => m.id === "u1")).toHaveLength(1);
  });
});

describe("approvals", () => {
  async function pendingApproval() {
    const ctx = await setup();
    const { conversationId, sessionId } = await conversationWithSession(ctx.alice);
    const approvalId = await ctx.alice.mutation(api.approvals.create, {
      conversationId,
      sessionId,
      action: { kind: "click", tabId: "t1", pageUrl: "https://example.com/form", elementRole: "button", elementName: "Send" },
      reason: "Submits a form",
    });
    return { ...ctx, conversationId, sessionId, approvalId };
  }

  test("cannot execute before the user approves", async () => {
    const { alice, approvalId } = await pendingApproval();
    await expect(alice.mutation(api.approvals.claimForExecution, { approvalId })).rejects.toThrow();
  });

  test("an approval executes at most once", async () => {
    const { alice, approvalId } = await pendingApproval();
    await alice.mutation(api.approvals.decide, { approvalId, decision: "approve" });
    const claimed = await alice.mutation(api.approvals.claimForExecution, { approvalId });
    expect(claimed.action.elementName).toBe("Send");
    await expect(alice.mutation(api.approvals.claimForExecution, { approvalId })).rejects.toThrow();
  });

  test("denied approvals can't be executed, and other users can't decide", async () => {
    const { alice, bob, approvalId } = await pendingApproval();
    await expect(bob.mutation(api.approvals.decide, { approvalId, decision: "approve" })).rejects.toThrow();
    await alice.mutation(api.approvals.decide, { approvalId, decision: "deny" });
    await expect(alice.mutation(api.approvals.claimForExecution, { approvalId })).rejects.toThrow();
  });

  test("ending the session expires pending approvals", async () => {
    const { alice, conversationId, sessionId, approvalId } = await pendingApproval();
    await alice.mutation(api.browserSessions.markEnded, { sessionId, status: "ended", reason: "test" });
    const list = await alice.query(api.approvals.listForConversation, { conversationId });
    expect(list.find((a) => a._id === approvalId)).toBeUndefined();
  });
});

describe("sessions", () => {
  test("one live browser session per user", async () => {
    const { alice } = await setup();
    await conversationWithSession(alice);
    const other = await alice.mutation(api.conversations.create, {});
    await expect(
      alice.mutation(api.browserSessions.createPending, { conversationId: other, provider: "demo", allowedDomains: [], timeoutSec: 600 }),
    ).rejects.toThrow();
  });

  test("ended sessions release the run lock", async () => {
    const { alice } = await setup();
    const { conversationId, sessionId } = await conversationWithSession(alice);
    await startRun(alice, conversationId, "u1");
    await alice.mutation(api.browserSessions.markEnded, { sessionId, status: "expired", reason: "idle" });
    const view = await alice.query(api.browserSessions.getForConversation, { conversationId });
    expect(view?.session).toMatchObject({ status: "expired", controllingRunId: null });
  });
});
