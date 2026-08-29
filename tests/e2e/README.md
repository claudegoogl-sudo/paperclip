# End-to-end specs (`tests/e2e`)

Playwright specs that drive a real, throwaway Paperclip instance end to end:
each run boots its own server from `pnpm paperclipai onboard --yes --run`,
points Chromium at it, and exercises the product the way an operator would.

## Running locally

```sh
pnpm run test:e2e            # full default lane (local_trusted)
pnpm run test:e2e:headed     # watch the browser
pnpm run test:e2e:multiuser-authenticated   # multi-user variant
```

The harness creates its own instance, so these are safe while a dev server is
running: the default lane binds to a dedicated port (`PAPERCLIP_E2E_PORT`,
default 3199), a temp `PAPERCLIP_HOME`, and deployment mode `local_trusted`.
The webServer refuses to reuse an existing server (`reuseExistingServer:
false`), so tests never attach to your active Paperclip home.

## How the lane is wired

- **Single worker, sequential files.** `playwright.config.ts` pins
  `workers: 1` because every spec shares one throwaway server and some specs
  toggle instance-level flags; cross-file parallelism is also the only path
  that surfaces the heartbeat-run/PATCH deadlock pair. Files must not assume
  ordering, but they must tolerate sharing the instance.
- **Retries are off (`retries: 0`).** A flaky spec is a bug in the spec or the
  product, and retry loops hide it. Fix the spec instead of re-running.
- **CI splits the catalog into 3 shards.** Each shard boots its own server and
  takes a deterministic longest-processing-time partition of the spec list
  (`scripts/e2e-shard.mjs` + `scripts/e2e-shard-durations.json`), so runners
  compute identical non-overlapping splits. The `e2e` aggregate job fails if
  any shard fails. CI sets `PAPERCLIP_E2E_SKIP_LLM=true`.
- **Two specs live outside the default lane.** `multi-user.spec.ts` and
  `multi-user-authenticated.spec.ts` are excluded via `testIgnore` and have
  their own configs (`playwright-multiuser*.config.ts`). The unit test in
  `scripts/__tests__/e2e-shard.test.mjs` fails if that ignore list and the
  sharder's `IGNORED_SPECS` ever drift apart.

## Writing resilient specs: the board-lock pattern

Specs drive a real board with real advisory locks (issue checkout,
`executionRunId` ownership). Under contention the API answers `409`, and a
mutation that wins a conflict retry can legitimately change the issue's
assignee or status in the same request. The `signoff-policy.spec.ts` helper
learned this the hard way: it discarded a successful conflict-retry PATCH
because the assignee it observed was the reviewer the flow had just assigned,
then fell back to a board checkout that `409`'d on the new `in_review` status.

Rules of thumb:

- Treat a `2xx` conflict-retry response as the mutation you asked for. Check
  the outcome you need, not incidental fields that the same request may have
  changed (assignee, status).
- Expect `409` around checkout/ownership transitions and retry through the
  documented conflict path instead of asserting on raw status codes.
- A caught `heartbeat_run_events` foreign-key warning during teardown is the
  spec's own agent deletion racing a finished run's scratch-cleanup append.
  It is logged, never touches the request path, and is not a failure signal.
