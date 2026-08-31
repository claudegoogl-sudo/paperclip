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

After a real publish, the installer/verify/rollback scripts remain a manual
release-asset step (they are authored per release and uploaded with
`gh release upload <tag> <file> --clobber`, which never touches the
tarballs).

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
  `bundleDependencies` manifest contract and ship the patched bundled
  runtime (registered patch marker per dependency, fail closed on drift).
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
  outage): `build.sh` used to strip `bundleDependencies` and pack workspace
  directories, so packages that upstream bundles — `adapter-utils` (acpx),
  `db` (embedded-postgres) — resolved their bundled dep from the npm
  registry on hosts, WITHOUT the repository's pnpm patches. Pristine acpx
  rejects the SCREAMING_CASE env map adapter-utils persists as
  `acpx.session_options.env`, killing every local agent start with
  `Persisted key policy violation`. Bundled packages are now staged through
  `scripts/prepare-bundled-package.mjs` (registry install + `patch -p1`
  re-application + marker validation) and packed from the staged directory,
  and the bundled-deps gate fails the build if any bundled tarball ships
  without the patched runtime.
