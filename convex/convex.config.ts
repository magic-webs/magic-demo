import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
  env: {
    // Optional: lets the cleanup cron release idle Browserbase sessions.
    BROWSERBASE_API_KEY: v.optional(v.string()),
    BROWSERBASE_PROJECT_ID: v.optional(v.string()),
  },
});

export default app;
