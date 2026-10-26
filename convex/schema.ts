import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export const browserProvider = v.union(
  v.literal("selfhosted"),
  v.literal("browserbase"),
  v.literal("demo"),
);

export const sessionStatus = v.union(
  v.literal("starting"),
  v.literal("running"),
  v.literal("reconnecting"),
  v.literal("ended"),
  v.literal("expired"),
  v.literal("error"),
);

export const runStatus = v.union(
  v.literal("running"),
  v.literal("completed"),
  v.literal("paused"),
  v.literal("stopped"),
  v.literal("superseded"),
  v.literal("failed"),
);

export const actionStatus = v.union(
  v.literal("executing"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("awaiting_approval"),
  v.literal("blocked"),
);

export const approvalStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("denied"),
  v.literal("executing"),
  v.literal("executed"),
  v.literal("failed"),
  v.literal("expired"),
);

export default defineSchema({
  ...authTables,

  conversations: defineTable({
    ownerId: v.id("users"),
    title: v.string(),
    lastMessageAt: v.number(),
  }).index("by_ownerId_and_lastMessageAt", ["ownerId", "lastMessageAt"]),

  // One row per UI message (AI SDK UIMessage). `parts` holds the sanitized
  // UIMessage parts; page text is stripped before it gets here.
  messages: defineTable({
    ownerId: v.id("users"),
    conversationId: v.id("conversations"),
    messageId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    parts: v.any(),
    runId: v.optional(v.id("agentRuns")),
  })
    .index("by_conversationId", ["conversationId"])
    .index("by_conversationId_and_messageId", ["conversationId", "messageId"]),

  browserSessions: defineTable({
    ownerId: v.id("users"),
    conversationId: v.id("conversations"),
    provider: browserProvider,
    // Provider's session id (Browserbase session id). Never a connect URL.
    providerSessionId: v.optional(v.string()),
    status: sessionStatus,
    paused: v.boolean(),
    activeTabId: v.optional(v.string()),
    controllingRunId: v.optional(v.id("agentRuns")),
    allowedDomains: v.array(v.string()),
    lastActivityAt: v.number(),
    expiresAt: v.number(),
    endedAt: v.optional(v.number()),
    endReason: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  })
    .index("by_ownerId_and_status", ["ownerId", "status"])
    .index("by_conversationId", ["conversationId"])
    .index("by_status_and_lastActivityAt", ["status", "lastActivityAt"]),

  browserTabs: defineTable({
    ownerId: v.id("users"),
    sessionId: v.id("browserSessions"),
    tabId: v.string(),
    title: v.string(),
    url: v.string(),
    position: v.number(),
    // Only used by the demo adapter, which simulates scrolling.
    scrollY: v.optional(v.number()),
  })
    .index("by_sessionId_and_position", ["sessionId", "position"])
    .index("by_sessionId_and_tabId", ["sessionId", "tabId"]),

  agentRuns: defineTable({
    ownerId: v.id("users"),
    conversationId: v.id("conversations"),
    sessionId: v.optional(v.id("browserSessions")),
    userMessageId: v.string(),
    status: runStatus,
    stopRequested: v.boolean(),
    stepCount: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    model: v.string(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_conversationId", ["conversationId"])
    .index("by_conversationId_and_userMessageId", [
      "conversationId",
      "userMessageId",
    ])
    .index("by_ownerId_and_status", ["ownerId", "status"]),

  actionLogs: defineTable({
    ownerId: v.id("users"),
    conversationId: v.id("conversations"),
    runId: v.optional(v.id("agentRuns")),
    sessionId: v.optional(v.id("browserSessions")),
    idempotencyKey: v.string(),
    tool: v.string(),
    // Short human-readable description, e.g. "Click “Pricing” link".
    label: v.string(),
    status: actionStatus,
    summary: v.optional(v.string()),
    pageTitle: v.optional(v.string()),
    pageUrl: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    approvalId: v.optional(v.id("approvals")),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
  })
    .index("by_conversationId", ["conversationId"])
    .index("by_idempotencyKey", ["idempotencyKey"]),

  approvals: defineTable({
    ownerId: v.id("users"),
    conversationId: v.id("conversations"),
    sessionId: v.id("browserSessions"),
    runId: v.optional(v.id("agentRuns")),
    actionLogId: v.optional(v.id("actionLogs")),
    // Exact action the user approves. Executed only by trusted server code.
    action: v.object({
      kind: v.union(v.literal("click"), v.literal("fill")),
      tabId: v.string(),
      pageUrl: v.string(),
      elementRole: v.string(),
      elementName: v.string(),
      text: v.optional(v.string()),
      submit: v.optional(v.boolean()),
    }),
    reason: v.string(),
    status: approvalStatus,
    decidedAt: v.optional(v.number()),
    resultSummary: v.optional(v.string()),
    expiresAt: v.number(),
  })
    .index("by_conversationId_and_status", ["conversationId", "status"])
    .index("by_sessionId_and_status", ["sessionId", "status"]),

  userSettings: defineTable({
    ownerId: v.id("users"),
    extraAllowedDomains: v.array(v.string()),
    showCursor: v.boolean(),
  }).index("by_ownerId", ["ownerId"]),

  usageRecords: defineTable({
    ownerId: v.id("users"),
    runId: v.id("agentRuns"),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    steps: v.number(),
    durationMs: v.number(),
  }).index("by_ownerId", ["ownerId"]),
});
