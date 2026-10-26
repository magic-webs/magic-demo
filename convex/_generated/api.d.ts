/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actionLogs from "../actionLogs.js";
import type * as agentRuns from "../agentRuns.js";
import type * as approvals from "../approvals.js";
import type * as auth from "../auth.js";
import type * as browserSessions from "../browserSessions.js";
import type * as cleanup from "../cleanup.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as lib_access from "../lib/access.js";
import type * as messages from "../messages.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  actionLogs: typeof actionLogs;
  agentRuns: typeof agentRuns;
  approvals: typeof approvals;
  auth: typeof auth;
  browserSessions: typeof browserSessions;
  cleanup: typeof cleanup;
  conversations: typeof conversations;
  crons: typeof crons;
  http: typeof http;
  "lib/access": typeof lib_access;
  messages: typeof messages;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
