// Boot-time build-identity self-check (PLA-632 defense-in-depth).
//
// Fork builds carry a `-fork.<n>` suffix in their version (e.g.
// `2026.428.1-fork.9`); upstream npm releases do not. When systemd resolves the
// bare name `paperclipai` via `npx`/`npm exec`, it can silently pull an upstream
// release from the public registry instead of the installed fork binary, which
// then crash-loops on fork-only guards. This module lets the run-path announce
// exactly which build is executing and, when the operator opts in, abort instead
// of silently running the wrong binary.

const FORK_MARKER = /-fork\.\d+/;

export type BuildChannel = "fork" | "upstream";

export interface BuildIdentity {
  version: string;
  isForkBuild: boolean;
  channel: BuildChannel;
}

export interface IdentityEnv {
  requireForkBuild?: string;
  expectedVersion?: string;
}

export type IdentityFailureReason = "version-mismatch" | "not-fork-build";

export interface IdentityAssertion {
  ok: boolean;
  identity: BuildIdentity;
  message: string;
  failureReason?: IdentityFailureReason;
}

export function describeBuildIdentity(version: string): BuildIdentity {
  const isForkBuild = FORK_MARKER.test(version);
  return { version, isForkBuild, channel: isForkBuild ? "fork" : "upstream" };
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

// Pure decision function so the boot guard is unit-testable without spawning a
// process. `version` is the running CLI's own version; `env` carries the
// operator's expectations (read from process.env at the call site).
export function assertBuildIdentity(version: string, env: IdentityEnv): IdentityAssertion {
  const identity = describeBuildIdentity(version);
  const expected = (env.expectedVersion ?? "").trim();
  const requireFork = isTruthy(env.requireForkBuild);

  if (expected.length > 0 && expected !== version) {
    return {
      ok: false,
      identity,
      failureReason: "version-mismatch",
      message:
        `Paperclip build-identity check FAILED: running version "${version}" does not match ` +
        `PAPERCLIP_EXPECTED_VERSION="${expected}". This usually means the service resolved a different ` +
        `"paperclipai" (e.g. an upstream npm release via "npx paperclipai run") instead of the installed ` +
        `build. Point ExecStart at the installed binary (e.g. /usr/bin/paperclipai run). Aborting.`,
    };
  }

  if (requireFork && !identity.isForkBuild) {
    return {
      ok: false,
      identity,
      failureReason: "not-fork-build",
      message:
        `Paperclip build-identity check FAILED: PAPERCLIP_REQUIRE_FORK_BUILD is set but the running build ` +
        `"${version}" is not a fork build (missing "-fork.<n>" marker). This usually means the service ` +
        `resolved the upstream "paperclipai" from the public npm registry (e.g. via "npx paperclipai run") ` +
        `instead of the installed fork binary. Point ExecStart at the installed binary ` +
        `(e.g. /usr/bin/paperclipai run). Aborting instead of running upstream.`,
    };
  }

  const notes: string[] = [];
  if (requireFork) notes.push("fork required: satisfied");
  if (expected.length > 0) notes.push(`expected ${expected}: matched`);
  const suffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  return {
    ok: true,
    identity,
    message: `Paperclip build identity: ${identity.channel} build ${version}${suffix}`,
  };
}

export function readIdentityEnv(env: NodeJS.ProcessEnv = process.env): IdentityEnv {
  return {
    requireForkBuild: env.PAPERCLIP_REQUIRE_FORK_BUILD,
    expectedVersion: env.PAPERCLIP_EXPECTED_VERSION,
  };
}
