# Fork releases: policy and runbook

This runbook covers **fork releases**: the `v<version>-fork.<n>` tags on
this repository that carry the installable host build for our deployment
(CLI tarball, all inner `@paperclipai/*` tarballs, checksums, and the
install/verify/rollback scripts). The npm release lanes (canary, nightly,
beta, stable) are different processes; see
[`RELEASING.md`](../RELEASING.md) and [`RELEASE-CHECKLIST.md`](../RELEASE-CHECKLIST.md).

## Immutability policy (never delete)

A published fork release is **immutable**. Never delete a release, and
never delete or replace its assets.

Why: every install script and rollback script for a release points at the
release's GitHub download URLs. Deleting a release breaks all of those URLs
at once. This failure mode has happened here: a broken release was deleted,
its rollback script vanished with it, and the host was left without a
working documented rollback path while it was down.

### When a release is broken

1. **Do not delete it.** Mark it instead. Prepend a DO-NOT-USE banner to
   the release notes:

   ```bash
   gh release view <tag> --repo OWNER/REPO --json body -q .body > /tmp/notes.md
   { echo '> **DO-NOT-USE — reason.** What is broken, in one line.'
     echo '> Do not install this release. Details below.'
     echo ''
     cat /tmp/notes.md
   } > /tmp/notes-bannered.md
   gh release edit <tag> --repo OWNER/REPO --notes-file /tmp/notes-bannered.md
   ```

2. **Name the defect and the affected assets** in the banner area, so the
   next reader does not have to rediscover the failure.

3. **Fix forward.** Cut the next fork release with the fix. Never re-use a
   version number and never re-point an existing tag.

4. **Mirror both releases** (the broken one and the fix). The broken
   release stays mirrored: it is still the rollback source for hosts that
   already installed it.

## Publish runbook (every fork release)

Run every step from a clean checkout of the release commit.

1. **Build and pass the preflight first.** The clean-sandbox preflight
   (install the CLI tarball from the exact release URLs → boot the server
   on a scratch data dir → `GET /` returns 200 with the Paperclip title
   page) must pass **before** anything is uploaded. A release that fails
   the preflight must not publish. See the release workflow family in
   `.github/workflows/` for the gate.

2. **Upload the release assets**: the CLI tarball, every inner
   `@paperclipai/*` tarball, `SHA256SUMS.txt` covering every tarball, and
   the install/verify/rollback scripts. Create the release with
   `--prerelease` for pre-releases. Never leave a release in `draft` state
   longer than needed; the mirror tool refuses drafts.

3. **Generate the install/verify/rollback scripts from the published
   assets**, never from a local tree that can drift. Each script pins the
   sha256 of the tarball it installs. The install script states the
   rollback one-liner; the rollback script points at the previous release.

4. **Mirror at publish time — hard precondition.** Run:

   ```bash
   scripts/mirror-fork-release.sh <tag>
   ```

   This downloads every asset to `~/backups/fork-releases/<tag>/assets/`,
   verifies every checksum, generates offline twins of the
   URL-referencing scripts, proves the mirror stands alone (self-test),
   and only then writes the `.mirror-ok` marker. **The host cutover starts
   only after this command prints OK.** New install scripts should also
   refuse to run when the marker is missing:

   ```bash
   test -f ~/backups/fork-releases/<tag>/.mirror-ok \
     || { echo "mirror not verified — run scripts/mirror-fork-release.sh <tag>"; exit 1; }
   ```

5. **Cutover** on the host with the install script, then run the release's
   verify script as the post-cutover check.

6. **Do not edit assets after publish.** If an asset absolutely must be
   corrected, say so in the release notes, and re-run the mirror script so
   the local copy is verified against the new bytes (the mirror detects
   the change, re-downloads, and converges; it never trusts a stale copy).

## Mirror layout

```
~/backups/fork-releases/
  mirror.log                     every mirror run, one line per step
  prune.log                      every retention prune, with the rule applied
  v<version>-fork.<n>/
    .mirror-ok                   marker; written only after full verification
    MANIFEST.json                tag metadata, per-asset sizes and sha256
    ROLLBACK.md                  offline rollback entry point (exact commands)
    assets/                      byte-identical copies of every release asset
    offline/                     generated twins of the URL-referencing scripts
```

The offline twins are byte-identical to the published scripts except that
release-download base URLs now resolve from the mirror (`file://` paths).
The mirror tool proves this in the self-test: it diffs each twin against
the published script (only the URL lines may differ) and then fetches and
checksums every artifact the twin would download, from the mirror alone,
with no GitHub access.

## Rollback when GitHub is down or the release was deleted

This is the scenario the mirror exists for.

1. Open `~/backups/fork-releases/<installed-tag>/ROLLBACK.md`.
2. Run the listed rollback script with sudo. It resolves every artifact
   from the mirror paths and keeps the published sha pins.
3. If the deleted release must also be restored on GitHub, re-create it
   from the mirror (notes from the incident record; assets from
   `assets/`):

   ```bash
   gh release create <tag> --repo OWNER/REPO --title "<title>" --notes "<notes>" \
     ~/backups/fork-releases/<tag>/assets/*
   ```

## Retention (what stays mirrored)

Default: keep the newest **three** fork releases (the current release plus
two back), **plus** any release that a kept release's scripts reference
(rollback targets). Prune only with the tool, so every prune is logged:

```bash
scripts/mirror-fork-release.sh <tag> --prune          # keep = 3
scripts/mirror-fork-release.sh <tag> --prune --keep 5 # wider window
```

Each prune appends one line to `prune.log` with the tag, the manifest
checksum, and the rule that removed it. Nothing is pruned silently, and a
tag that a kept release can still roll back to is never removed.

## Verify the mirror any time

Re-running the tool on a mirrored tag is safe and idempotent: it
re-verifies every checksum, regenerates the twins, re-runs the self-test,
and rewrites the marker. Use it after any GitHub-side change or as a
periodic drill of the offline path.

```bash
scripts/mirror-fork-release.sh <tag>
```
