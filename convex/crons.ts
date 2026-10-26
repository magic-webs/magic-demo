import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("release stale browser sessions", { minutes: 2 }, internal.cleanup.releaseStaleSessions, {});

export default crons;
