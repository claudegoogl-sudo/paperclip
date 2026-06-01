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

  const handlers = createHostClientHandlers({
    pluginId: PLUGIN_KEY,
    capabilities: ["secrets.read-ref"],
    services: { secrets: secretsHandler } as never,
  });

  return { handlers, registry };
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
    const entry = (logActivity as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(entry).toMatchObject({
      actorType: "plugin",
      agentId: null,
      runId: SERVICE_RUN_ID,
      companyId: OWNER_COMPANY,
    });
    expect(entry.details).toMatchObject({ outcome: "allowed", dispatchingAgentId: null });
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

  it("still fails closed (runcontext_invalid) with neither dispatch nor service scope", async () => {
    const { handlers } = buildWorld();

    // A forged worker→host call outside any dispatch and without a service
    // scope surfaces no runId, so the server handler fails closed.
    await expect(
      handlers["secrets.resolve"]({ secretRef: BOT_TOKEN_SECRET_REF } as never, {}),
    ).rejects.toMatchObject({ code: "runcontext_invalid" });
  });
});
