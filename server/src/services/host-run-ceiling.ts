import { availableParallelism } from "node:os";

export const HOST_MAX_CONCURRENT_RUNS_ENV_VAR = "PAPERCLIP_MAX_CONCURRENT_RUNS_HOST";
export const HOST_MAX_CONCURRENT_RUNS_MIN = 1;
export const HOST_MAX_CONCURRENT_RUNS_MAX = 50;

export type HostRunCeiling = {
  value: number;
  source: "env" | "default";
  vcpuCount: number;
  /** Present when the env var was set but unusable, so startup can say why it was ignored. */
  invalidEnvValue?: string;
};

function clampHostMaxConcurrentRuns(value: number) {
  return Math.max(HOST_MAX_CONCURRENT_RUNS_MIN, Math.min(HOST_MAX_CONCURRENT_RUNS_MAX, value));
}

export function readVcpuCount() {
  const parallelism = availableParallelism();
  return Number.isFinite(parallelism) && parallelism > 0 ? Math.floor(parallelism) : 1;
}

export function defaultHostMaxConcurrentRuns(vcpuCount: number) {
  const vcpus = Number.isFinite(vcpuCount) && vcpuCount > 0 ? Math.floor(vcpuCount) : 1;
  return clampHostMaxConcurrentRuns(Math.ceil(vcpus / 2));
}

export function resolveHostRunCeiling(rawEnvValue: unknown, vcpuCount = readVcpuCount()): HostRunCeiling {
  const fallback: HostRunCeiling = {
    value: defaultHostMaxConcurrentRuns(vcpuCount),
    source: "default",
    vcpuCount,
  };
  if (typeof rawEnvValue !== "string") return fallback;
  const trimmed = rawEnvValue.trim();
  if (trimmed === "") return fallback;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || Math.floor(parsed) < 1) {
    return { ...fallback, invalidEnvValue: trimmed };
  }
  return {
    value: clampHostMaxConcurrentRuns(Math.floor(parsed)),
    source: "env",
    vcpuCount,
  };
}
