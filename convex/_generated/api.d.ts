/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _migrations_dropAlgoclash from "../_migrations/dropAlgoclash.js";
import type * as analytics from "../analytics.js";
import type * as analyticsEvents from "../analyticsEvents.js";
import type * as controlAccounts from "../controlAccounts.js";
import type * as devices from "../devices.js";
import type * as http from "../http.js";
import type * as licenses from "../licenses.js";
import type * as messages from "../messages.js";
import type * as nativeHedgeLive from "../nativeHedgeLive.js";
import type * as nativeHedgeLiveValidation from "../nativeHedgeLiveValidation.js";
import type * as parts from "../parts.js";
import type * as permissions from "../permissions.js";
import type * as projects from "../projects.js";
import type * as sessionShares from "../sessionShares.js";
import type * as sessions from "../sessions.js";
import type * as subscriptions from "../subscriptions.js";
import type * as todos from "../todos.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "_migrations/dropAlgoclash": typeof _migrations_dropAlgoclash;
  analytics: typeof analytics;
  analyticsEvents: typeof analyticsEvents;
  controlAccounts: typeof controlAccounts;
  devices: typeof devices;
  http: typeof http;
  licenses: typeof licenses;
  messages: typeof messages;
  nativeHedgeLive: typeof nativeHedgeLive;
  nativeHedgeLiveValidation: typeof nativeHedgeLiveValidation;
  parts: typeof parts;
  permissions: typeof permissions;
  projects: typeof projects;
  sessionShares: typeof sessionShares;
  sessions: typeof sessions;
  subscriptions: typeof subscriptions;
  todos: typeof todos;
  workspaces: typeof workspaces;
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
