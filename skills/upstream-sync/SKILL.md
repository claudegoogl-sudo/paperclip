---
name: upstream-sync
description: >
  Keep claudegoogl-sudo/paperclip in sync with paperclipai/paperclip releases.
  Use when a scheduled routine wakes you to apply an upstream release, when a
  sync PR needs manual triage, or when bootstrapping/repairing the routine's
  state file.
---

# Upstream Sync

Pulls upstream `paperclipai/paperclip` releases into the
`claudegoogl-sudo/paperclip` fork. Parent issue: PLA-589 (routine spec);
scaffolding lands via PLA-603. The weekly cron registration is owned by the
sibling task and lives outside this skill.

> **Direction matters.** This is the inverse of `release_via_fork_install_request`:
> we pull upstream changes inward, then the board lands them on the fork via
> the existing fork-install flow.

## 1. Where things live

| Artifact | Path |
|---|---|
| Sync-tick entrypoint | `scripts/upstream-sync.mjs` |
| Trivial conflict resolver | `scripts/resolve-trivial-sync-conflicts.mjs` |
| PR body formatter | `scripts/format-sync-pr-body.mjs` |
| Plugin-activation soak | `scripts/plugin-activation-soak.mjs` |
| Routine state (lastSyncedTag, ETag) | `.paperclip/upstream-sync.json` |
| CI gate | `.github/workflows/pr.yml` (must be green before approval) |

The fork has two remotes:

- `origin` → `claudegoogl-sudo/paperclip` (push destination)
- `upstream` → `paperclipai/paperclip` (read-only source)

If `upstream` is missing on a fresh checkout, add it:

```bash
git remote add upstream https://github.com/paperclipai/paperclip.git
```

## 2. Waking the routine manually

```bash
# safe — read-only, no branch/PR side effects
node scripts/upstream-sync.mjs --dry-run

# full tick — fetches upstream, may create sync/upstream-<tag>, push, open draft PR
GITHUB_TOKEN=<fork-scoped-PAT> node scripts/upstream-sync.mjs
```

A successful dry-run against an unchanged upstream prints:

```
no-op: still at <tag>
```

The scheduled cron (sibling task) invokes the non-dry-run form on a quiet
cadence (weekly is fine; the ETag on `releases/latest` means quiet ticks cost
one 304 round trip).

## 3. Conflict buckets

When `git merge upstream/<tag>` reports conflicts,
`resolve-trivial-sync-conflicts.mjs` runs first. It only touches an allow-list:

1. **`pnpm-lock.yaml`** — take theirs, then `pnpm install --no-frozen-lockfile`
   to regenerate a lockfile genuinely owned by the sync branch.
   The fork's `pr.yml` lockfile-block carves out only `chore/refresh-lockfile`,
   not sync branches, so the lockfile change must look authored by this branch.
2. **`CHANGELOG*`** — concatenate upstream + fork sides with a divider; never
   prefer one.
3. **`docs/**.md`, `README*`** — take theirs when both sides only added prose
   (no deletions on either side). Upstream is canonical for prose docs.

Everything else stays with conflict markers and routes into one of three
buckets in the routine's escalation report:

| Bucket | When | Action |
|---|---|---|
| `clean` | No conflicts after resolver | Routine opens a draft PR. |
| `reviewable` | ≤ 5 files unresolved, no `.github/`/`Dockerfile`/`docker/` involved | Routine emits `{tag, unresolvedFiles, bucket: "reviewable"}` JSON on stdout and exits non-zero; the calling agent files a small follow-up issue with the JSON quoted. |
| `escalation` | Anything touching infra (`.github/`, `Dockerfile`, `docker/`) or > 5 unresolved files | Routine emits the same JSON with `bucket: "escalation"`; the calling agent escalates to CTO immediately and does not retry on the same tag. |

The routine never retries the same upstream tag silently — once a sync attempt
is escalated, only an explicit human-driven re-run (after the conflict is
addressed) should advance `.paperclip/upstream-sync.json`.

## 4. State file

`.paperclip/upstream-sync.json` is the durable cursor. Required shape:

```json
{
  "lastSyncedTag": "v2026.428.0",
  "lastSyncedSha": "<commit sha at or past upstream tag>",
  "lastSyncedAt": "ISO-8601",
  "etag": "W/\"...\"",
  "lastCheckedAt": "ISO-8601",
  "pendingPrUrl": null,
  "lastConflictBuckets": { "clean": 1, "reviewable": 0, "escalation": 0 }
}
```

- `etag` is the value the routine sends as `If-None-Match` to the upstream
  `releases/latest` endpoint. A 304 round-trips with the same ETag and the
  routine exits 0 with `no-op: still at <tag>`.
- `lastSyncedTag` is a defense-in-depth check: even if the ETag has rotated
  but `tag_name` is unchanged, the routine refreshes the ETag and exits 0.
- `pendingPrUrl` carries the draft PR URL between the merge commit and the
  board approval, so a re-run can detect "PR already open for this tag" and
  skip re-creating it. (Sibling B will wire the dedup; the scaffold leaves
  the slot.)

## 5. Where escalations land

| Trigger | Destination |
|---|---|
| `escalation` bucket from the routine | New child issue under PLA-589, board-visible, includes JSON report verbatim and the upstream tag |
| `reviewable` bucket from the routine | Same parent (PLA-589), labelled for the calling agent to handle inline |
| PR CI failure on `pr.yml` | Treated as P0 per `public_pr_ci_clean_gate`; fix or close before requesting approval |
| Upstream API 5xx | Routine exits non-zero with the body; retry on next tick is fine |

## 5b. Plugin-activation soak gate (PLA-640)

After a clean merge, **before** advancing state or pushing, the tick runs a
plugin-activation soak (`scripts/plugin-activation-soak.mjs` via
`runActivationSoakGate`). Root cause: PLA-639 — CAD went `error` on the v525
cut (`Package root not found for plugin "platform.cad"`) because it had been
installed from a `/tmp` source dir that the host recorded as `packagePath`
without copying; systemd-tmpfiles swept the dir and the next restart could not
re-resolve the package root. klipper has the same latent defect.

The soak boots an **isolated** host (`local_trusted`, loopback, embedded
PostgreSQL in a throwaway `--data-dir` — never `~/.paperclip`), installs CAD
and klipper from their release tarballs (extracted to a **persistent** staging
dir, never `/tmp`), and asserts each reaches `status: "ready"` with a
non-ephemeral `packagePath`. Any non-ready plugin, or a `packagePath` under a
swept location, fails the tick (no PR opened).

```bash
# stand-alone (what the gate shells out to):
SOAK_CAD_TARBALL=/path/to/platform-paperclip-plugin-cad-<v>.tgz \
SOAK_KLIPPER_TARBALL=/path/to/platform-paperclip-klipper-<v>.tgz \
  node scripts/plugin-activation-soak.mjs --json

# skip for a tick that runs the soak elsewhere (loud, never silent):
PAPERCLIP_SYNC_SKIP_SOAK=1 node scripts/upstream-sync.mjs
```

The soak prerequisites (a built `server/dist/index.js` and the release
tarballs) come from the surrounding build/release step. If they are missing the
soak exits non-zero and the gate aborts the tick — a missing soak is treated as
a failure, never a silent pass.

## 6. Board-gated landing

The routine **never** auto-merges. After the draft PR is green:

1. Agent posts the PR URL on PLA-589 (or the sync sub-issue), with the dry-run
   output as evidence.
2. Board approves the merge into `claudegoogl-sudo/paperclip:master`.
3. CTO routes a fork-install request to CEO per
   `release_via_fork_install_request`, and the new fork version reaches this
   instance through the existing fork-merge → build → install flow.

## 7. Common failure modes

- **`upstream` remote missing** → add it (`git remote add upstream …`); the
  routine assumes it is already configured.
- **State file drift** (e.g. someone hand-edited a tag) → re-bootstrap by
  setting `lastSyncedTag` to the tag of `git merge-base origin/master upstream/master`
  and clearing `etag`/`pendingPrUrl`. The next tick will fetch fresh.
- **`pnpm install` fails during lockfile regen** → leave the resolver's
  output in place, mark the bucket `escalation`, and surface the install log
  in the escalation issue.
- **PR create returns 422** → almost always "branch already exists with an
  open PR". Re-use `pendingPrUrl` from state instead of force-creating.
