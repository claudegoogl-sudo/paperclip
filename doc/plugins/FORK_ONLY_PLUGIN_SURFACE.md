# Fork-Only Plugin Host-Service Surface

Status: fork-only documentation for the `sync/upstream-v2026.824.1` lineage.
This file describes surfaces that exist ONLY in this fork. Upstream's public
plugin SDK surface is kept byte-compatible; nothing documented here exists
upstream, and upstream behavior on upstream surfaces is unchanged.

## Disposition summary

The fork diverged from upstream in how plugin workers reach company-scoped
host services from background contexts (worker-lifetime loops, reconciliation
passes, inbound relays). Upstream denies company-scoped reads proactively at
the SDK when no host-issued company context exists. The fork originally
relaxed upstream's own public reads; the reviewed disposition restores
upstream's semantics on the public surface and moves every fork need onto
explicitly fork-only methods:

1. `config.get` / `secrets.resolve` — upstream's proactive company-context
   rejection is restored byte-compatibly. The only delta is
   `forkLegacyScopeContext()` in `host-client-factory.ts`, which presents the
   host-attributed `singleInFlightScope` (the host's single in-flight dispatch,
   never worker-supplied) AS the invocation scope for legacy id-less workers.
   Upstream contexts never carry `singleInFlightScope`, so for every
   upstream-constructible context it is a provable no-op.
2. `approvals.list` — upstream's general read again. The fork's reconcile
   contract moved to `approvals.listPending`.
3. `events.subscribe` — deliberately NOT covered by the serviceScope
   allowance. Upstream pins its denial for companies outside the configured
   set; a `setup()`-time subscribe for a configured company is authorized by
   the host's options-seeded proactive scope, which surfaces as a real
   invocation scope.

## Fork-only methods

All three are declared in the SDK protocol/types, mocked in the SDK testing
helpers, and served by `plugin-host-services.ts`.

| Method | Purpose | Authority | Safety argument |
| --- | --- | --- | --- |
| `approvals.listPending` | Messenger digest reconciliation snapshot | Worker-chosen concrete `companyId`, re-validated server-side | Pending-only default; field-minimized projection (no descriptions/PII); missed-blocker seeding; defensive `RECONCILE_LIST_LIMIT` row cap; full provisioning gate (company exists, install present, plugin enabled) |
| `config.getForServiceScope` | Background effective-config read | Worker-chosen concrete `companyId` behind the real `requirePluginEnabledForCompany` availability gate | Base+override merge only (no secret material); read-only; unprovisioned/disabled/uninstalled companies fail closed |
| `secrets.resolveService` | Worker-lifetime background secret read (e.g. messenger bot token) | Company is DERIVED from the secret binding — never accepted from the worker | Host-minted `serviceScope.runId` mandatory; ambiguous cross-company bindings collapse to `not_found`; rate-limited per plugin; value registered with the run-scoped redactor |

Bridge-level complete mediation (SDK `host-client-factory.ts`): a missing or
empty `companyId` on `approvals.listPending` / `config.getForServiceScope` is
rejected before the host service runs; `secrets.resolveService` rejects a
worker-supplied `companyId` outright.

## serviceScope allowance (`SERVICE_SCOPE_COMPANY_METHODS`)

When no dispatch pins a company, the bare host-minted `serviceScope` (a key
only this fork's host attaches) authorizes exactly this set of company-scoped
methods; each is independently reach-checked server-side, so a forged
`companyId` cannot reach a foreign tenant. `kind:"all"` requests and
non-allowlisted methods keep failing closed.

| Method | Per-method safety argument |
| --- | --- |
| `state.get` / `state.set` / `state.delete` | Plugin-private namespaced state; company scoping only narrows the plugin's own data |
| `issues.createComment` | Write is cross-checked server-side (`requireInCompany`); human attribution additionally requires a separate capability |
| `issues.resolveInteraction` | Entity is resolved and company-checked server-side before mutation |
| `artifacts.create` | Host re-validates company scope plus size/mime/idempotency; write-only |
| `interactions.list` | Interaction rows are entity-cross-checked server-side; read-only snapshot for reconciliation |
| `approvals.listPending` | See table above |
| `config.getForServiceScope` | See table above |

`secrets.resolve` is deliberately NOT in this set (upstream-strict); background
secret reads must use `secrets.resolveService`. `events.subscribe` is
deliberately not in this set (see disposition summary).

## Negative-test map

- SDK (`packages/plugins/sdk/tests/host-client-factory.test.ts`):
  scope-less `config.get` / `secrets.resolve` denial; forged `companyId`
  denial; `secrets.resolve` denial under bare serviceScope; `events.subscribe`
  denial under serviceScope (with and without `invalidInvocationScope`);
  fork-only method bridge rejections (missing/empty `companyId`, missing
  serviceScope, worker-supplied `companyId`).
- Server (`server/src/__tests__/`):
  `plugin-reconcile-reads-host-services.test.ts` — unknown company,
  uninstalled install, disabled plugin, missing/empty `companyId` all fail
  closed on the fork-only reads; `plugin-worker-manager.test.ts` — scope-less
  and ambiguous-scope calls denied before host services run; upstream-pinned
  `events.subscribe` denials for unseeded companies;
  `plugin-worker-background-attribution.test.ts` — a setup()-loop background
  read is denied outright instead of falling back to an instance-wide payload.

## Defense in depth

The server-side fail-close in the secrets/config handlers (run-context
validation, company derivation from bindings) is unchanged and remains the
second layer beneath every SDK-side guard described here.
