/**
 * Matches exactly the unauthenticated webhook ingestion route
 * (`POST /api/plugins/:pluginId/webhooks/:endpointKey`) so `app.ts` can mount a
 * tighter JSON body parser in front of the generic 10mb one.
 *
 * An explicit `RegExp` rather than a wildcard string pattern: Express 5 parses
 * string mount paths with path-to-regexp v8, where the wildcard syntax changed
 * and no longer means what it did in Express 4. The two `[^/]+` groups keep the
 * match to a single path segment each, so sibling routes — the delivery list at
 * `/api/plugins/:pluginId/webhooks`, or `/api/plugins/:pluginId/config` — keep
 * the generic limit.
 */
export const PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN = /^\/api\/plugins\/[^/]+\/webhooks\/[^/]+\/?$/;
