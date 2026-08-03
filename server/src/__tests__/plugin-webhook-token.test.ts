import { describe, expect, it } from "vitest";

import type { PluginWebhookAuthDeclaration } from "@paperclipai/shared";

import { isVerifiedWebhookDelivery } from "../services/plugin-webhook-auth.js";
import {
  WEBHOOK_TOKEN_ENTROPY_FLOOR_BITS,
  WebhookTokenEntropyError,
  assertWebhookTokenMeetsFloor,
  generateWebhookSalt,
  generateWebhookToken,
  generateWebhookTokenSecret,
  maxTokenEntropyBits,
} from "../services/plugin-webhook-token.js";

const auth: PluginWebhookAuthDeclaration = {
  type: "header-token",
  header: "X-Telegram-Bot-Api-Secret-Token",
  tokenDigestConfigKey: "webhookTokenDigest",
};

describe("generateWebhookTokenSecret", () => {
  it("mints a base62 token that clears the 128-bit floor", () => {
    for (let i = 0; i < 20; i++) {
      const token = generateWebhookTokenSecret();
      expect(/^[0-9A-Za-z]+$/.test(token)).toBe(true);
      expect(maxTokenEntropyBits(token)).toBeGreaterThanOrEqual(
        WEBHOOK_TOKEN_ENTROPY_FLOOR_BITS,
      );
    }
  });

  it("does not repeat across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(generateWebhookTokenSecret());
    expect(seen.size).toBe(50);
  });
});

describe("generateWebhookSalt", () => {
  it("mints a hex salt past the 16-char minimum", () => {
    const salt = generateWebhookSalt();
    expect(/^[0-9a-f]+$/.test(salt)).toBe(true);
    expect(salt.length).toBeGreaterThanOrEqual(16);
  });
});

describe("assertWebhookTokenMeetsFloor", () => {
  it("refuses a sub-floor operator-chosen token", () => {
    // The worked example from the issue: short, brute-forceable.
    expect(() => assertWebhookTokenMeetsFloor("hunter2")).toThrow(
      WebhookTokenEntropyError,
    );
    expect(() => assertWebhookTokenMeetsFloor("")).toThrow(
      WebhookTokenEntropyError,
    );
  });

  it("accepts a token long enough to carry the floor", () => {
    expect(() =>
      assertWebhookTokenMeetsFloor("A1b2C3d4E5f6G7h8I9j0K1l2M3"),
    ).not.toThrow();
  });
});

describe("generateWebhookToken end to end", () => {
  it("produces a digest that verifies via isVerifiedWebhookDelivery", () => {
    const { token, digestConfig } = generateWebhookToken();

    const verified = isVerifiedWebhookDelivery({
      auth,
      headers: { [auth.header.toLowerCase()]: token },
      config: { [auth.tokenDigestConfigKey]: digestConfig },
      pluginId: "plugin-1",
      endpointKey: "telegram",
    });
    expect(verified).toBe(true);
  });

  it("does not verify a different token against the same digest", () => {
    const { digestConfig } = generateWebhookToken();
    const verified = isVerifiedWebhookDelivery({
      auth,
      headers: { [auth.header.toLowerCase()]: generateWebhookTokenSecret() },
      config: { [auth.tokenDigestConfigKey]: digestConfig },
      pluginId: "plugin-1",
      endpointKey: "telegram",
    });
    expect(verified).toBe(false);
  });

  it("verifies a floor-passing supplied token but refuses a sub-floor one", () => {
    const supplied = "A1b2C3d4E5f6G7h8I9j0K1l2M3";
    const { token, digestConfig } = generateWebhookToken(supplied);
    expect(token).toBe(supplied);
    expect(
      isVerifiedWebhookDelivery({
        auth,
        headers: { [auth.header.toLowerCase()]: supplied },
        config: { [auth.tokenDigestConfigKey]: digestConfig },
        pluginId: "plugin-1",
        endpointKey: "telegram",
      }),
    ).toBe(true);

    expect(() => generateWebhookToken("weak")).toThrow(WebhookTokenEntropyError);
  });
});
