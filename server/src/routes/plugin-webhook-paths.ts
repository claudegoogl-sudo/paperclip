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
 *
 * The `i` flag is load-bearing, not sloppiness. Express's `case sensitive
 * routing` setting is off by default, so the router happily dispatches
 * `POST /API/plugins/<id>/WEBHOOKS/<key>` to the handler. Without `i` this
 * mount would miss those variants, they would fall through to the generic 10mb
 * parser, and the tighter cap would be opt-out by changing the case of one
 * character. Keep this flag in step with the router's case sensitivity.
 */
export const PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN = /^\/api\/plugins\/[^/]+\/webhooks\/[^/]+\/?$/i;
