# Review rules for this fork

Read by CodeRabbit (see `.coderabbit.yaml`) and by human reviewers.
This file is a gate: a PR that changes it, `.coderabbit.yaml`, test config or CI scripts is
flagged by `pa-ci-ab` (observe mode, warning only) and needs a named human reviewer.

## Look at these first (Critical / Major if wrong)

1. **Fork-only hunks.** Code that exists only in this fork (not in `paperclipai/paperclip`).
   Check `git diff <merge-base> origin/master -- <file>`. Never accept an upstream-style
   rewrite of a file that has fork changes. Upstream-sync PRs must keep fork hunks.
2. **Security controls.** Auth, grants, permissions, secrets handling, adapter or tool access,
   plugin capabilities. Look for: a check that moved after the action it guards, a deny path that
   falls through to allow, a new route without an actor/company check.
3. **Redaction.** Logs, run output, comments, error text, persisted metadata. A new field that can
   carry a secret must go through the redaction path. Encoded forms (base64, hex, URL) count.
4. **Database migrations.** Append-only (`scripts/check-migrations-append-only.mjs`). Never edit an
   applied migration. Check lock level, backfill cost, and that a second run is a no-op.
5. **Review gate and CI gates.** Any change to review-gate logic, `pa-ci*`, skip or ignore lists,
   vitest config, `scripts/run-vitest-stable.mjs`, shard lists, or this file. A PR must not
   weaken the gate that tests it. A removed or skipped test needs a written reason.
6. **Startup sweeps and timers.** Code that runs at boot or on an interval: bounded work,
   idempotent, no destructive action without a guard, no unbounded query, safe on a second run.
7. **Production paths.** Anything that changes what runs in production (installer, wrapper,
   runtime, plugin host). It needs a rollback path and a version check.

## Also check

- Tests prove the change: a new test must fail without the fix.
- No secret, token, key or customer data in the diff, fixtures or logs.
- No internal ticket ids in PR bodies (see PR template).
- Idempotency of scripts and jobs.

## Nits (do not block, mention at most once)

- Naming, formatting, import order, comment wording, small refactors outside the change.
- Style already enforced by the formatter or linter.
- Docs typos that do not change meaning.

## Do not

- Suggest auto-fix pushes on sync or release branches.
- Ask for changes in files the PR does not touch, unless the PR breaks them.
