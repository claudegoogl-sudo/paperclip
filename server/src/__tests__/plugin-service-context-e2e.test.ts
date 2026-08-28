/**
 * End-to-end seam test for the worker-lifetime service context.
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
 * onEvent relay resolve. Those reads must target the fork-only
 * `secrets.resolveService` surface: upstream's `secrets.resolve` guard is
 * restored byte-compatibly and refuses a bare-serviceScope read at the SDK
 * seam, so `secrets.resolveService` (binding-derived company, host-minted
 * service scope mandatory) is the contract the poll loop and onEvent relay
 * resolve against. It asserts the token resolves and is attributed to the
 * plugin system actor.
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

const PLUGIN_DB_ID = "messenger-install-1";
const PLUGIN_KEY = "platform.messenger";
// The real bot-token binding from AC4 (value below is a placeholder).
const BOT_TOKEN_SECRET_REF = "aec3df6f-ef95-4572-b786-290e3baa1a8e";
const OWNER_COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_RUN_ID = "00000000-0000-4000-8000-00000000beef";
const TEST_TOKEN = "TEST-bot-token-not-a-real-secret";

function buildWorld() {
  const registry = createPluginRunContextRegistry({
    ttlMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  // The worker-manager registers this at worker start.
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

  // Mirror the host wiring (plugin-host-services): the fork-only
  // `resolveService` routes to the SAME server handler — only the SDK-side
  // gate differs (upstream-strict company context on `secrets.resolve`,
  // binding-derived company + mandatory service scope on
  // `secrets.resolveService`).
  const secretsService = {
    resolve: secretsHandler.resolve.bind(secretsHandler),
    resolveService: secretsHandler.resolve.bind(secretsHandler),
    mintHandle: secretsHandler.mintHandle.bind(secretsHandler),
  };

  const handlers = createHostClientHandlers({
    pluginId: PLUGIN_KEY,
    capabilities: ["secrets.read-ref"],
    services: { secrets: secretsService } as never,
  });

  return { handlers, secretsHandler, registry };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRunSecretValues(SERVICE_RUN_ID);
});

afterEach(() => {
  clearRunSecretValues(SERVICE_RUN_ID);
});

describe("service-context e2e (messenger getUpdates + onEvent)", () => {
  it("resolves the bot token from a setup()-loop tick with no dispatch in flight", async () => {
    const { handlers } = buildWorld();

    // Exactly what runPollLoop does on the fork-only surface: resolveService
    // with NO runId; the only scope on the call context is the host-minted
    // service scope, and the company comes from the operator-created binding.
    const value = await handlers["secrets.resolveService"](
      { secretRef: BOT_TOKEN_SECRET_REF } as never,
      { serviceScope: { runId: SERVICE_RUN_ID } } as never,
    );

    expect(value).toBe(TEST_TOKEN);

    // Attributed to the plugin system actor — not a spoofed agent/user run.
    // The synthetic service runId is not a heartbeat_runs row, so the
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
    // as a background dispatch, again carrying only the service scope, again
    // on the fork-only surface.
    const value = await handlers["secrets.resolveService"](
      { secretRef: BOT_TOKEN_SECRET_REF } as never,
      { serviceScope: { runId: SERVICE_RUN_ID } } as never,
    );

    expect(value).toBe(TEST_TOKEN);
  });

  it("denies a bare-serviceScope secrets.resolve (upstream guard restored)", async () => {
    const { handlers } = buildWorld();

    // The fork's former fail-open behavior is gone: `secrets.resolve` carrying
    // only the worker-lifetime service scope is refused at the SDK seam.
    // Background reads must target `secrets.resolveService`.
    await expect(
      handlers["secrets.resolve"](
        { secretRef: BOT_TOKEN_SECRET_REF } as never,
        { serviceScope: { runId: SERVICE_RUN_ID } } as never,
      ),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });
  });

  it("still fails closed at both layers with neither dispatch nor service scope", async () => {
    const { handlers, secretsHandler } = buildWorld();

    // SDK seam: a forged worker→host call outside any dispatch and without a
    // service scope has no company context, so the restored upstream guard
    // denies before the server handler runs.
    await expect(
      handlers["secrets.resolve"]({ secretRef: BOT_TOKEN_SECRET_REF } as never, {}),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });

    // Server seam (defense in depth): past the SDK, the handler still fails
    // closed when the registry holds no active context for the claimed run.
    await expect(
      secretsHandler.resolve({
        secretRef: BOT_TOKEN_SECRET_REF,
        runId: "00000000-0000-4000-8000-00000000dead",
      } as never),
    ).rejects.toMatchObject({ code: "runcontext_invalid" });
  });
});
