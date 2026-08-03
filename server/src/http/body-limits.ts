export const DEFAULT_JSON_BODY_LIMIT = "10mb";
/**
 * Cap for the unauthenticated plugin webhook ingestion route. The generic 10mb
 * ceiling lets one anonymous POST write 10 MB of attacker-chosen JSON into the
 * `plugin_webhook_deliveries.payload` jsonb column. Real provider payloads are
 * far smaller — Telegram updates are single-digit KB, Stripe events tens of KB
 * — so 1mb keeps two orders of magnitude of headroom for other providers while
 * cutting the worst-case anonymous write by 10x.
 */
export const WEBHOOK_JSON_BODY_LIMIT = "1mb";
export const PORTABLE_JSON_BODY_LIMIT = "64mb";
export const PORTABLE_JSON_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
