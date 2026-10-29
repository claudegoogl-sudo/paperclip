import { describe, expect, it } from "vitest";
import type { Environment, InstanceExecutionMode } from "@paperclipai/shared";
import {
  isKubernetesSandboxEnvironment,
  resolveForcedKubernetesEnvironment,
} from "./forced-kubernetes-environment";

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    name: "Environment",
    description: null,
    driver: "sandbox",
    status: "active",
    config: {},
    envVars: {},
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("isKubernetesSandboxEnvironment", () => {
  it("is true for a sandbox driver with a kubernetes provider", () => {
    const environment = makeEnvironment({ config: { provider: "kubernetes" } });
    expect(isKubernetesSandboxEnvironment(environment)).toBe(true);
  });

  it("is false when the driver is not sandbox even if provider is kubernetes", () => {
    const environment = makeEnvironment({
      driver: "local",
      config: { provider: "kubernetes" },
    });
    expect(isKubernetesSandboxEnvironment(environment)).toBe(false);
  });

  it("is false when the sandbox provider is not kubernetes", () => {
    const environment = makeEnvironment({ config: { provider: "fake" } });
    expect(isKubernetesSandboxEnvironment(environment)).toBe(false);
  });

  it("is false when config has no provider at all", () => {
    const environment = makeEnvironment({ config: {} });
    expect(isKubernetesSandboxEnvironment(environment)).toBe(false);
  });
});

describe("resolveForcedKubernetesEnvironment", () => {
  it("is not forced when executionMode is undefined", () => {
    const result = resolveForcedKubernetesEnvironment(undefined, []);
    expect(result).toEqual({ forced: false, kubernetesEnvironment: null });
  });

  it("is not forced when executionMode is 'any'", () => {
    const kubernetesEnv = makeEnvironment({ config: { provider: "kubernetes" } });
    const result = resolveForcedKubernetesEnvironment("any" as InstanceExecutionMode, [
      kubernetesEnv,
    ]);
    expect(result).toEqual({ forced: false, kubernetesEnvironment: null });
  });

  it("is forced with the matching environment when executionMode is 'kubernetes'", () => {
    const localEnv = makeEnvironment({ id: "env-local", driver: "local", config: {} });
    const kubernetesEnv = makeEnvironment({
      id: "env-k8s",
      config: { provider: "kubernetes" },
    });
    const result = resolveForcedKubernetesEnvironment("kubernetes", [localEnv, kubernetesEnv]);
    expect(result.forced).toBe(true);
    expect(result.kubernetesEnvironment).toBe(kubernetesEnv);
  });

  it("is forced with a null environment when none of the loaded environments match", () => {
    const localEnv = makeEnvironment({ id: "env-local", driver: "local", config: {} });
    const result = resolveForcedKubernetesEnvironment("kubernetes", [localEnv]);
    expect(result).toEqual({ forced: true, kubernetesEnvironment: null });
  });

  it("is forced with a null environment when the environment list is empty", () => {
    const result = resolveForcedKubernetesEnvironment("kubernetes", []);
    expect(result).toEqual({ forced: true, kubernetesEnvironment: null });
  });

  it("picks the first matching kubernetes environment when more than one is present", () => {
    const first = makeEnvironment({ id: "env-k8s-1", config: { provider: "kubernetes" } });
    const second = makeEnvironment({ id: "env-k8s-2", config: { provider: "kubernetes" } });
    const result = resolveForcedKubernetesEnvironment("kubernetes", [first, second]);
    expect(result.kubernetesEnvironment).toBe(first);
  });
});
