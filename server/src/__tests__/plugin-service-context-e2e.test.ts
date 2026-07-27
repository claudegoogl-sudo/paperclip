/**
 * PLA-768 — end-to-end seam test for the worker-lifetime service context.
 *
 * Wires the REAL worker→host backfill (`createHostClientHandlers` from the SDK)
 * to the REAL server-side secrets handler + run-context registry, then drives
 * the exact call shape a background plugin makes:
 *
 *   ctx.secrets.resolve(secretRef)   // NO runId — no dispatch in flight
 *
 * with only the host-minted `serviceScope` present on the call context (as the
 * worker-manager surfaces it on every worker→host call). This reproduces both
 * the messenger `getUpdates` setup()-loop resolve AND the `approval.created`
 * onEvent relay resolve, which previously failed Gate 1 with
 * `runcontext_invalid`. It asserts the token now resolves and is attributed to
 * the plugin system actor.
 *
 * The bot-token secretRef is the real messenger binding from the issue; the
 * resolved value is a TEST placeholder — no real secret material is used.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({ resolveSecretValue: vi.fn().mockResolvedValue("unused") }),
}));

const { logActivity } = await import("../services/activity-log.js");
const { createPluginRunContextRegistry } = await import(
  "../services/plugin-run-context-registry.js"
);
const { createPluginSecretsHandler } = await import(
  "../services/plugin-secrets-handler.js"
);
const { clearRunSecretValues } = await import("../run-secret-registry.js");
const { buildSecretsResolveService } = await import(
  "../services/plugin-host-services.js"
);

const PLUGIN_DB_ID = "messenger-install-1";
const PLUGIN_KEY = "platform.messenger";
// The real bot-token binding from PLA-768 AC4 (value below is a placeholder).
const BOT_TOKEN_SECRET_REF = "aec3df6f-ef95-4572-b786-290e3baa1a8e";
const OWNER_COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_RUN_ID = "00000000-0000-4000-8000-00000000beef";
const TEST_TOKEN = "TEST-bot-token-not-a-real-secret";

function buildWorld() {
  const registry = createPluginRunContextRegistry({
    ttlMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  // The worker-manager registers this at worker start (PLA-768 task #2).
  registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);

  const secretsHandler = createPluginSecretsHandler({
    db: {} as never,
    pluginDbId: PLUGIN_DB_ID,
    pluginKey: PLUGIN_KEY,
    runContextRegistry: registry,
    bindings: {
      findBinding: async () => null,
      findServiceBinding: async (input) =>
        input.secretId === BOT_TOKEN_SECRET_REF
          ? {
              companyId: OWNER_COMPANY,
              id: "binding-bot-token",
              secretId: BOT_TOKEN_SECRET_REF,
              configPath: "telegramBotTokenSecretId",
              versionSelector: "latest",
              allowedEgress: [],
              egressAllowlistEnforced: false,
            }
          : null,
    },
    resolver: { resolve: async () => TEST_TOKEN },
  });

  // PLA-1819: drive the REAL `buildHostServices` secrets wrapper, not the bare
  // handler. The previous `services: { secrets: secretsHandler }` stub skipped
  // the layer where v722 added `ensureCompanyId`, so this suite read green
  // while the live path threw on every resolve. The availability callback is
  // recorded so tests can assert WHICH branch ran.
  const availabilityChecks: string[] = [];
  const services = {
    secrets: {
      resolve: buildSecretsResolveService(secretsHandler, async (companyId) => {
        availabilityChecks.push(companyId);
      }),
      mintHandle: secretsHandler.mintHandle,
    },
  } as never;

  const handlers = createHostClientHandlers({
    pluginId: PLUGIN_KEY,
    capabilities: ["secrets.read-ref"],
    services,
  });

  return { handlers, registry, availabilityChecks };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRunSecretValues(SERVICE_RUN_ID);
});

afterEach(() => {
  clearRunSecretValues(SERVICE_RUN_ID);
});

describe("PLA-768 service-context e2e (messenger getUpdates + onEvent)", () => {
  it("resolves the bot token from a setup()-loop tick with no dispatch in flight", async () => {
    const { handlers } = buildWorld();

    // Exactly what runPollLoop does: resolve with NO runId; the only scope on
    // the call context is the host-minted service scope.
    const value = await handlers["secrets.resolve"](
      { secretRef: BOT_TOKEN_SECRET_REF } as never,
      { serviceScope: { runId: SERVICE_RUN_ID } },
    );

    expect(value).toBe(TEST_TOKEN);

    // Attributed to the plugin system actor — not a spoofed agent/user run.
    // PLA-806: the synthetic service runId is not a heartbeat_runs row, so the
    // durable audit row writes run_id = NULL and preserves the synthetic id
    // under details.backgroundRunId + details.runContextKind (avoids the 23503
    // FK drop that previously swallowed the whole audit insert).
    const entry = (logActivity as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(entry).toMatchObject({
      actorType: "plugin",
      agentId: null,
      runId: null,
      companyId: OWNER_COMPANY,
    });
    expect(entry.details).toMatchObject({
      outcome: "allowed",
      dispatchingAgentId: null,
      backgroundRunId: SERVICE_RUN_ID,
      runContextKind: "service",
    });
  });

  it("resolves the same token from the onEvent (approval.created) background relay", async () => {
    const { handlers } = buildWorld();

    // The onEvent handler also resolves the token to deliver outbound; it runs
    // as a background dispatch, again carrying only the service scope.
    const value = await handlers["secrets.resolve"](
      { secretRef: BOT_TOKEN_SECRET_REF } as never,
      { serviceScope: { runId: SERVICE_RUN_ID } },
    );

    expect(value).toBe(TEST_TOKEN);
  });

  it("still fails closed with neither dispatch nor service scope", async () => {
    const { handlers } = buildWorld();

    // A forged worker→host call outside any dispatch and without a service
    // scope surfaces no tenant binding at all.
    //
    // PLA-1819: the denial moved one layer earlier. It used to reach the server
    // handler and fail there as `runcontext_invalid`; now the gated wrapper's
    // `resolveRequiredCompanyId` denies first (no invocationScope, no
    // singleInFlightScope, no serviceScope.runId) and host services are never
    // entered. The server-side gate is untouched and remains the second layer.
    await expect(
      handlers["secrets.resolve"]({ secretRef: BOT_TOKEN_SECRET_REF } as never, {}),
    ).rejects.toMatchObject({ name: "InvocationScopeDeniedError" });
  });
});

describe("PLA-1819 — v722 companyId contract, end to end through buildHostServices", () => {
  it("does not require companyId on the PLA-768 service path", async () => {
    // Regression for the defect in be872d0a4. v722 changed BOTH halves of the
    // guard: the SDK half injects `companyId`, the server half requires it. The
    // branch took only the server half, so the messenger poll loop — which has
    // no company to inject — threw "companyId is required for this operation"
    // instead of resolving the operator's bot token.
    const { handlers, availabilityChecks } = buildWorld();

    const value = await handlers["secrets.resolve"](
      { secretRef: BOT_TOKEN_SECRET_REF } as never,
      { serviceScope: { runId: SERVICE_RUN_ID } },
    );

    expect(value).toBe(TEST_TOKEN);
    // Pass-through branch: no company pin exists, so no availability check can
    // run here. The handler derives the owning company from the binding row.
    expect(availabilityChecks).toEqual([]);
  });

  it("runs the tenant-availability check when a dispatch pins a company", async () => {
    // The in-dispatch path DOES carry a host-derived pin, which the SDK now
    // injects. Injecting it is what buys the wrapper's
    // `ensurePluginAvailableForCompany` gate — plugins are global (one worker
    // serves every tenant), so this is the per-company enablement check.
    const { handlers, registry, availabilityChecks } = buildWorld();
    const DISPATCH_RUN = "00000000-0000-4000-8000-00000000cafe";
    registry.register(PLUGIN_DB_ID, {
      kind: "dispatch",
      companyId: OWNER_COMPANY,
      agentId: "agent-1",
      runId: DISPATCH_RUN,
      projectId: "project-1",
      toolName: "messenger.send",
      registeredAt: Date.now(),
    });

    // The fixture only stubs `findServiceBinding`, so the dispatch lookup ends
    // in `not_found`. That is fine and deliberate: the availability gate runs
    // in the wrapper BEFORE the handler, so reaching the handler at all proves
    // the companyId was injected and the required branch was taken. Pre-fix
    // this threw "companyId is required" out of the wrapper and never got here.
    await expect(
      handlers["secrets.resolve"](
        { secretRef: BOT_TOKEN_SECRET_REF, runId: DISPATCH_RUN } as never,
        { invocationScope: { companyId: OWNER_COMPANY, runId: DISPATCH_RUN } },
      ),
    ).rejects.toThrow(/secret not found/);

    expect(availabilityChecks).toEqual([OWNER_COMPANY]);
  });

  it("rejects an empty-string companyId rather than treating it as absent", async () => {
    // The pass-through branch keys on `undefined` specifically. An empty string
    // is a malformed pin, not a service context, and must still fail closed —
    // otherwise a falsy value would silently select the relaxed branch.
    const { handlers } = buildWorld();
    const resolve = buildSecretsResolveService(
      {
        resolve: async () => TEST_TOKEN,
        mintHandle: async () => "unused",
      } as never,
      async () => {},
    );

    await expect(
      resolve({ secretRef: BOT_TOKEN_SECRET_REF, runId: SERVICE_RUN_ID, companyId: "" } as never),
    ).rejects.toThrow(/companyId is required/);
    expect(handlers).toBeDefined();
  });
});
