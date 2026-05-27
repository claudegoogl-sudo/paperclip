# PLA-597 runbook: fork e2e flake — Postgres deadlock + Playwright install hang

## Symptoms

The fork's `e2e` GitHub Actions check fails red on a public-repo PR with one of two unrelated infrastructure shapes. Both look like real test failures at first glance and routinely waste reviewer time.

### Shape 1 — Postgres deadlock 40P01 during `signoff-policy.spec.ts`

`PATCH /api/issues/:id` (typically with `status:"done"`, `"in_progress"`, or `"cancelled"`) returns 500 with a `PostgresError: deadlock detected` log entry. The test then fails because the response is not OK and the expected status transition did not happen.

Diagnostic fingerprint in `WebServer` job logs:

```
ERROR PATCH /api/issues/<uuid> 500 — deadlock detected
  err.code: "40P01"
  err.where: "while locking tuple (X,Y) in relation 'heartbeat_runs'"
  detail: "Process N waits for ShareLock on transaction A; blocked by process M.
           Process M waits for ShareLock on transaction B; blocked by process N."
```

The failing test is usually in `tests/e2e/signoff-policy.spec.ts` (rows around `:333`, `:372`, `:411`), but any concurrent PATCH against the shared webServer can hit it.

### Shape 2 — `playwright install --with-deps chromium` hangs after browser download

The job log shows the Chrome zip finishing (~167 MiB, 100% bar) and then nothing for 28 minutes until the job-level 30-minute timeout cancels the step. The orphaned process is `npm exec playwright install --with-deps chromium`. The `--with-deps` half of the command invokes `sudo apt-get install` for the system dependencies, and that is what stalls — usually on a dpkg/network blip — without timing out on its own.

## Root causes

### Shape 1 — heartbeat_runs / issues lock-order

Two server-side code paths take row locks on `issues` and `heartbeat_runs` in opposite order:

- `PATCH /api/issues/:id` clearing execution state takes a RowExclusiveLock on the `issues` row first, then touches the `heartbeat_runs` row referenced by `executionRunId` (via `heartbeat.cancelRun` or its successors).
- The heartbeat-run lifecycle (background sweepers, `releaseIssueExecutionAndPromote`, queued-run claim/cancel) takes a lock on the `heartbeat_runs` row first, then on the corresponding `issues` row.

When these two paths interleave on the same issue ↔ run pair, Postgres detects the cycle and rolls one of the transactions back with SQLSTATE `40P01`.

Because Playwright runs spec files in parallel workers by default and the e2e suite shares one webServer process, two unrelated spec files can drive this interleaving without doing anything obviously concurrent at the test level.

### Shape 2 — bundled `--with-deps` step

`playwright install --with-deps chromium` is a single CI step combining a browser download and a `sudo apt-get install`. There is no inner timeout; the job-level 30-minute budget is the only ceiling. When apt hangs, the Chrome zip is already on disk but no visible step fails — the entire job is silently cancelled at the 30-minute mark.

## Fix landed (PR #28, branch `pla-597/e2e-flake-fix`)

1. **Bounded retry in `PATCH /api/issues/:id`.** `server/src/services/pg-retry.ts` provides `retryOnTransientPgError`, which retries on SQLSTATE `40P01` (deadlock_detected) and `40001` (serialization_failure) with bounded exponential backoff + jitter, up to 4 attempts. The PATCH route handler (`server/src/routes/issues.ts`) wraps both branches of its transaction block in this helper. A rolled-back transaction leaves no partial state, so retrying is safe.
2. **Deterministic test isolation in CI.** `tests/e2e/playwright.config.ts` pins `workers: 1` when `process.env.CI` is set, so spec files run strictly sequentially against the shared webServer. Cross-spec parallelism is the only path that surfaces the lock-order race in tests. Local runs are unaffected.
3. **Cached, split Playwright install.** `.github/workflows/pr.yml` and `.github/workflows/e2e.yml` add an `actions/cache@v4` step on `~/.cache/ms-playwright` keyed by `pnpm-lock.yaml` hash, then `npx playwright install chromium` (gated on cache-miss, 5-min timeout) and `sudo npx playwright install-deps chromium` (10-min timeout). On cache hit the browser download is a no-op; on cache miss it is bounded; an apt hang now fails the deps step in ≤10 min with a clear name instead of eating the whole job budget.
4. **Rerun policy in `CONTRIBUTING.md`.** A single rerun is allowed for infra-shaped failures; a second failure of the same step is treated as a real bug; checks are never disabled to land a PR.

## Verification

- Server unit tests in `server/src/__tests__/pg-retry.test.ts` (9 cases) cover retryable code detection, retry-then-success, exhaustion, and non-retryable rethrow.
- The retry helper logs each retry at `warn` with the call-site `label`, so even after the mitigation the deadlocks remain visible in `server.log` for trend tracking. Watch for `label=patch_issue` warnings spiking — if they reappear at >1% of PATCH /issues calls, the root-cause fix (unifying the lock order across paths) becomes a real priority.
- The CTO gate per PLA-597 is three consecutive green e2e runs on `claudegoogl-sudo/paperclip:master` after this PR merges. Track the runs on the Actions tab; reopen PLA-597 if any of the three are red for the same reason.

## Repro for future regressions

To reproduce the deadlock locally without the full e2e harness:

1. Start the dev server: `pnpm dev` (or attach to an existing instance).
2. Create a company, an executor agent, and an issue with a two-stage execution policy. The test setup helpers in `tests/e2e/signoff-policy.spec.ts:setupCompany` / `createIssueWithPolicy` are the minimum recipe.
3. From two terminals, run the executor → done PATCH and a heartbeat-invoke against the same issue back-to-back in a tight loop. The deadlock surfaces within seconds; you should see `WARN retrying postgres transaction after transient error label=patch_issue code=40P01` in `~/.paperclip/instances/default/logs/server.log` and the request still returns 200 (mitigation working).
4. To verify the workflow-side fix, run `npx playwright install chromium` against a clean `~/.cache/ms-playwright` and confirm the cache key invalidates only when `pnpm-lock.yaml` changes.

## See also

- PR #28 — `claudegoogl-sudo/paperclip#28` — landing commit set.
- PLA-575 — the parent issue whose CI red triggered this work.
- `server/src/services/pg-retry.ts` — the retry helper.
- `tests/e2e/playwright.config.ts` — single-worker CI pin.
