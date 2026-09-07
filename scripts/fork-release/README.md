# Fork release pipeline

Fork core-host releases are GitHub-Release tarball sets published on
`claudegoogl-sudo/paperclip` (never npm publishes). The core CLI tarball pins
every internal `@paperclipai/*` dependency to an exact
`releases/download/v<version>/<asset>.tgz` URL, and installing the core
tarball resolves the whole internal graph through those URLs.

## The gate

The `Fork Release` workflow (`.github/workflows/fork-release.yml`) is the
release pipeline. Nothing becomes public unless a clean-sandbox preflight
passes first:

1. `build_pack` — builds the workspace, packs every package, URL-pins every
   internal dependency to this release, and runs the static gates.
2. `preflight` — stages the set on a **draft** release (invisible to the
   public), then:
   - verifies every tarball against `SHA256SUMS.txt`;
   - verifies the URL-pin closure (every internal dep is the exact release
     URL of this release, and every referenced asset is in the set);
   - verifies every manifest in the release set (all tarballs, not only the
     core install closure) points its `main`/`exports`/`types` and
     `paperclipPlugin` entrypoint targets at files that ship in the same
     tarball;
   - clean-sandbox `npm install` of the core tarball **from the exact
     published release URLs** (no `file:` overrides, no local paths), so the
     full internal graph resolves the way it will for customers;
   - boots the installed server against a **scratch data dir** (isolated
     `HOME`, embedded Postgres on an ephemeral port, random auth secrets);
   - requires `GET /` to answer **HTTP 200 with `<title>Paperclip</title>`**;
   - tears the server and its Postgres down and verifies the ports are
     released.
3. `publish` — flips the draft public. This job exists only when the
   preflight succeeded and both `dry_run` and `negative_test_fork34` are off.

Any preflight failure deletes the draft release: a broken build leaves zero
published assets and a red run. Draft staging exists because a draft's assets
are not anonymously downloadable; the preflight serves the staged,
sha256-verified bytes at the identical URL strings through a loopback mirror
(`release-url-mirror.mjs`) so npm resolves exactly the URLs the release will
publish.

## Running it

Dispatch `Fork Release` with `version` (for example `2026.824.1-fork.35`).
Leave `dry_run` on to exercise every gate without publishing; turn it off to
publish after the preflight. `negative_test_fork34` corrupts the packed db
tarball into the historically-shipped dev-exports defect (`exports ->
./src/index.ts` with no `src/` packed) and must always fail the run — it is
the standing proof that the gate blocks that class.

## Operator assets: install + rollback scripts

Every train publishes two scripts as release assets: an install script and
a rollback script. Name them `install-<base>-<train>.sh` and
`rollback-<prev-base>-<prev-train>.sh` (for example `install-fork907.43.sh`
and `rollback-fork824.42.sh`).

This is the standing convention. The fork.38 through fork.42 trains shipped
no scripts. The fork.43 install request went out as raw `npm install -g`
one-liners. Both moves forced the next operator request to re-derive the
install and rollback mechanics. Decision (2026-09-07): script assets are
the canonical operator-facing artifact. Raw tarball one-liners are a
degraded fallback for urgent trains only. The operator request links the
script asset URLs.

Rules for the scripts:

- Author them after the publish, from the published bytes. Each script pins
  the sha256 of the tarball it installs. The rollback script pins the
  previous release tarball URL and its sha256. Both must resolve and verify
  from the served bytes at authoring time. A rollback that 404s is worse
  than none.
- Keep them idempotent and sandbox-testable. Make `BIN`, `ROOT`,
  `INST_DIR`, `WINDOW_LOCK`, and `API` env-overridable. Use a
  `$INST_DIR/pg-window.lock` flock window lock with the epoch on line 1.
  Stop the service, install, start, then gate on the service version and
  `GET /` health before printing `RESULT OK` and the rollback one-liner.
- Upload with `gh release upload <tag> <file> --clobber`. This never
  touches the tarballs or other assets. Never delete published assets.
- Sandbox-test every gate in both scripts before upload. Record the run
  evidence on the train record.

The workflow does not author or upload these scripts. They stay a manual
post-publish step because each script pins the previous release bytes, and
those bytes exist only after that release publishes.

## Scripts

- `build.sh <version>` — build + pack + URL-pin + static gates. Safe to
  re-run. `--negative-test-fork34` applies the test-only corruption after
  the static gates.
- `preflight.mjs --core-url <url> --assets-dir <dir>` — the gate itself; all
  steps can run standalone (`--steps checksums,closure,exports,install,boot`).
- `pin-internal-deps.mjs` — post-pack URL pinning; self-verifies with the
  closure scan and converges on re-runs.
- `release-url-mirror.mjs` — loopback HTTPS mirror that serves staged
  release assets at their exact published URL strings.
- `negative-test-fork34.mjs` — test-only defect injector; never run against
  a set you intend to publish.
- `negative-test-empty-provider.mjs` — test-only defect injector for the
  empty-provider class (a packed plugin tarball whose manifest points at
  `./dist/*` with no `dist/` shipped); never run against a set you intend
  to publish.
- `stage-bundled-packages.mjs` — stage + pack every release package that
  declares `bundleDependencies` (see the defect class above).
- `gate-bundled-tarballs.mjs` — static gate: bundled tarballs must keep the
  `bundleDependencies` manifest contract, ship the patched bundled runtime
  (registered patch marker per dependency), and carry `package/LICENSE`
  (fail closed on drift; staging falls back to the repo-root LICENSE).
- `lib.mjs` — the URL-closure / export-target / checksum checks.
- `lib.test.mjs`, `workflow.test.mjs`, `bundled-deps.test.mjs` — unit tests
  for the checks and the workflow wiring (run in PR CI).

## Defect classes this gate exists for

- **Bare-version internal pins** (shipped once as fork.17): the fork has no
  npm presence, so `npm install` hits the registry and fails with `ETARGET`.
  Caught statically by the closure scan.
- **Dev manifests shipped in tarballs** (shipped as fork.25, fork.26, and
  fork.34): `exports -> ./src/index.ts` with no `src/` packed. The install
  succeeds and doctor passes; the server dies at boot with
  `Cannot find module '@paperclipai/db/src/index.ts'`. Caught statically by
  the export-target scan and dynamically by the boot step.
- **Providers packed without ever being built** (shipped across several
  releases): the sandbox-provider plugins sit outside the pnpm workspace,
  so the workspace build never produced their `dist/` while their packed
  manifests kept pointing at `./dist/*` — and being invisible to the core
  install closure, no gate noticed. `build.sh` now builds every provider
  before packing, and the export-target scan covers every tarball in the
  release set, so an unbuilt (or any other target-less) tarball fails the
  gate instead of shipping.
- **Patched bundled dependencies shipped pristine** (shipped as fork.36
  through fork.38; caused the fork.37 `claude_local` `ensure_session`
  outage; recurrence shipped as fork.39-fork.42 via `adapter-acpx-local`):
  `build.sh` used to strip `bundleDependencies` and pack workspace
  directories, so packages that upstream bundles — `adapter-utils` (acpx),
  `adapter-acpx-local` (acpx), `db` (embedded-postgres) — resolved their
  bundled dep from the npm registry on hosts, WITHOUT the repository's pnpm
  patches. Pristine acpx rejects the SCREAMING_CASE env map adapter-utils and
  the acpx-local adapter persist as `acpx.session_options.env`, killing every
  local agent start with `Persisted key policy violation`. Bundled packages
  are now staged through
  `scripts/prepare-bundled-package.mjs` (registry install + `patch -p1`
  re-application + marker validation) and packed from the staged directory,
  and the bundled-deps gate fails the build if any bundled tarball ships
  without the patched runtime.
- **License dropped from restaged tarballs** (shipped as fork.39): the
  restaged bundled packages (`adapter-utils`, `db`) are packed from a staging
  directory, and neither package directory carries a LICENSE file — the
  staged license copy was a silent no-op, so those tarballs published without
  a license. Staging now falls back to the repo-root LICENSE (README is never
  fallen back), and the bundled-deps gate rejects any bundled tarball without
  `package/LICENSE`.

## Provenance stamp + merged-vs-running drift check

**The problem this closes.** `done` on a host-code change means *merged*;
the fleet reads it as *running*. Those differ on every release train: any PR
merged between the cut commit and the operator's install is silently absent
from the running host. Nothing else checks.

### 1. Source-commit stamp (build time)

Every packed tarball's manifest carries a `gitHead` field with the exact
source commit:

- `scripts/generate-npm-package-json.mjs` stamps the CLI (root) package.
- `scripts/pack-public-packages.mjs` stamps every other public package
  (server, adapters, ...) as part of its publishConfig pass.
- `scripts/prepare-bundled-package.mjs` stamps packages packed from a staged
  copy outside the repository, where npm/pnpm cannot infer provenance.
- `scripts/generate-plugin-package-json.mjs` and
  `scripts/generate-ui-package-json.mjs` stamp the plugin and UI manifests.
  Their packages regenerate the manifest in a `prepack` step, which would
  otherwise wipe the stamp written before pack ran.

Resolution order lives in `scripts/source-commit.mjs`: `RELEASE_SOURCE_COMMIT`
env (validated 40-hex) wins, then `git rev-parse HEAD`. `build.sh` gate (e)
calls `verifyCommitStamp()` and FAILS the train if any tarball in the release
set is unstamped or carries a stamp other than the released commit — a train
can no longer ship without provenance.

### 2. drift-check.mjs (install/verify time)

```
node scripts/fork-release/drift-check.mjs [options]
```

Resolves the installed commit — the `gitHead` stamp first, release-tag lookup
as fallback — fetches the target ref fresh, and prints every commit on the
target that the running install does not contain, with PR refs (and an
optional deployment-local ticket regex).

Exit codes: `0` clean, `1` drift (warning, not a hard failure — the operator
may knowingly run an older pin), `2` environment error, `3` positive-control
failure.

**Positive control is mandatory.** The resolved base must be an ancestor of
the target or the check exits 3 and prints NO ledger. A check that cannot
distinguish "absent" from "looking in the wrong place" manufactures confident
false alarms — e.g. grepping a single bundle file for a server-side symbol
returns 0 for every server-side sentinel including ones that definitely
shipped. Scan the whole install closure via the commit ledger, never one file
via `grep`.

### 3. drift-sweep.mjs (scheduled)

Same ledger code path as drift-check, posted to a tracker issue when the
missing-commit set CHANGES (retries and re-runs converge; no spam). Board
credential is read in-process from `~/.paperclip/auth.json` (or
`$PAPERCLIP_API_KEY`) and never logged. Every post carries an agent-provenance
banner and records no operator decision. Control failures fail the service
and post nothing — never a fabricated ledger.

Deploy:

```
mkdir -p ~/work/fork-drift ~/.config/fork-drift
cp scripts/fork-release/drift-check.mjs scripts/fork-release/drift-sweep.mjs ~/work/fork-drift/
cat > ~/.config/fork-drift/env <<ENV
DRIFT_TRACKER_ISSUE=<tracker-issue-key>
DRIFT_AGENT_LABEL=fork-drift sweep
ENV
mkdir -p ~/.config/systemd/user
cp scripts/fork-release/systemd/paperclip-fork-drift.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now paperclip-fork-drift.timer
journalctl --user -u paperclip-fork-drift.service -n 20
```

Smoke-test one iteration by hand before enabling the timer:

```
node ~/work/fork-drift/drift-check.mjs                 # the ledger, human-readable
node ~/work/fork-drift/drift-sweep.mjs --issue <key>   # one sweep, posts once
node ~/work/fork-drift/drift-sweep.mjs --issue <key>   # converged: no second post
```
