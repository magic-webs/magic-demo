import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { env } from "./_generated/server";

const IDLE_MS = 10 * 60 * 1000;

/**
 * Expires idle/over-time sessions and asks Browserbase to release them.
 * Browserbase's own session timeout is the final backstop if this misses one.
 */
export const releaseStaleSessions = internalAction({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.runQuery(internal.browserSessions.listStale, {
      now: Date.now(),
      idleMs: IDLE_MS,
    });
    for (const s of stale) {
      if (s.provider === "browserbase" && s.providerSessionId && env.BROWSERBASE_API_KEY) {
        try {
          const res = await fetch(`https://api.browserbase.com/v1/sessions/${s.providerSessionId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-BB-API-Key": env.BROWSERBASE_API_KEY },
            body: JSON.stringify({
              status: "REQUEST_RELEASE",
              ...(env.BROWSERBASE_PROJECT_ID ? { projectId: env.BROWSERBASE_PROJECT_ID } : {}),
            }),
          });
          if (!res.ok && res.status !== 404) {
            console.warn(`Browserbase release returned ${res.status} for a stale session`);
          }
        } catch {
          console.warn("Browserbase release request failed; provider timeout will end it.");
        }
      }
      await ctx.runMutation(internal.browserSessions.expireInternal, {
        sessionId: s._id,
        reason: "Idle timeout",
      });
    }
    return null;
  },
});
