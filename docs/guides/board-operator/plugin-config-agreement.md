---
title: Plugin Config Agreement (Company-Scoped Config, Instance-Uniform Reads)
summary: Why some plugin config edits must be applied to every owning company, and how to recognize and repair a broken agreement
---

`plugin_config` is company-scoped — a plugin can own one row per company. Most plugins are configured once and expected to behave the **same for every company** (a shared API endpoint, a shared default branch, a shared feature flag). A plugin that reads its config with no dispatched company in scope (a construction-time or background read, not tied to a specific tenant's request) can only resolve that read if **every owning row agrees** on the non-secret-ref portion of `config_json`. This is the read-side agreement gate (`getAgreedOrDeny`, `server/src/services/plugin-host-services.ts`). Secret-ref fields (`format: "secret-ref"` in the manifest's `instanceConfigSchema`) are excluded from the agreement check — each company's secret binding is its own.

## Why an ordinary edit can break this

`POST /api/plugins/:pluginId/config` writes exactly **one company's row**. If a plugin's rows currently agree and an admin edits one company's config in the normal way, that row now disagrees with the rest — the read gate starts denying the no-dispatch read for every company, not just the one that was edited.

For `paperclip-messenger`, that no-dispatch read backs the live inbound operator Telegram poll loop — losing it is a silent outage, not a loud error in the UI.

## The write-path guard

`POST /api/plugins/:pluginId/config` refuses (`409`) a write that would break an agreement currently held across owning rows:

- **Fires only when it matters**: 2+ rows own the config, they currently agree, and this write disagrees with that agreement. A plugin with one row, or rows that already disagree, is unaffected — the guard never invents an invariant that isn't already there.
- **Response body** names the diverging top-level keys and the two ways forward.

To resolve a `409`, resubmit the same request with one of:

- **`"applyToAllCompanies": true`** — applies the non-secret-ref portion of the change to every owning row, atomically. Each row keeps its own secret-ref values untouched; a foreign company's secret is never copied onto another company's row. This is the normal repair for a plugin that's meant to be instance-uniform.
- **`"allowDivergence": true`** — writes only the target company's row, no guard. Use this only when the plugin is intentionally configured per-company and this divergence is expected.

The two flags are mutually exclusive (`400` if both are set).

## Recognizing a broken agreement in production

- `plugins.lastError` on the affected plugin's row is set to a bounded message naming the plugin and the fact of divergence (never company ids or config values).
- A structured `logger.error` line naming `pluginId`, the diverging company ids, and the diverging top-level keys (no values).
- For `paperclip-messenger` specifically: the inbound operator Telegram poll loop goes silent with no user-facing error — check `plugins.lastError` for the plugin first.

## Cross-tenant secret-ref handling

See the PLA-1843 findings (tracked in the issue, not yet a merged doc as of this writing) for the history of how a naive fan-out can over-share or reject a company's own unchanged secret-ref value. The `applyToAllCompanies` fan-out here only ever touches the non-secret-ref portion of the config; each row's existing secret-ref values are read back and re-applied verbatim, so a foreign secret-ref is never written to a company that doesn't own it.

The executable reference for this flow is
`server/src/__tests__/plugin-config-write-agreement-guard.test.ts`, which exercises the guard (single-row and already-diverged non-firing, held-agreement denial), the `applyToAllCompanies` fan-out (distinct and identical secret-ref values, atomicity under a forced mid-fan-out failure), `allowDivergence`, and the combined write-then-read (`getAgreedOrDeny`) resolution against an embedded Postgres instance.
