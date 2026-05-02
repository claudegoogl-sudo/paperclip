/**
 * Regression tests for PLA-190 / PLA-187:
 * the host `secrets.resolve` rejection path must NOT echo the caller-supplied
 * value back into the error message. Inputs that look like GitHub PATs,
 * Bearer tokens, or other opaque secret-shaped strings must be redacted to a
 * `kind=opaque len=<N>` descriptor.
 *
 * Synthetic, shape-valid test fixtures only — never use real PAT prefixes
 * recovered from incident logs.
 */

import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { createPluginSecretsHandler } from "../services/plugin-secrets-handler.ts";

// Stub Db — none of these test cases exercise db reads. Validation rejects
// before the handler reaches the database layer.
const stubDb = {} as unknown as Db;

function makeHandler() {
  return createPluginSecretsHandler({ db: stubDb, pluginId: "test-plugin" });
}

async function captureRejection(
  fn: () => Promise<unknown>,
): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to reject");
}

describe("plugin-secrets-handler — rejected ref redaction (PLA-190)", () => {
  it("redacts a ghp_-shaped value as opaque with no prefix leak", async () => {
    const handler = makeHandler();
    // Synthetic, shape-valid GitHub PAT — never use a real one in fixtures.
    const value = "ghp_" + "A".repeat(36);

    const err = await captureRejection(() =>
      handler.resolve({ secretRef: value }),
    );

    expect(err.name).toBe("InvalidSecretRefError");
    expect(err.message).toContain("kind=opaque");
    expect(err.message).toContain(`len=${value.length}`);
    // The classic and the prefix alone must both stay out of the message.
    expect(err.message).not.toContain(value);
    expect(err.message).not.toContain("ghp_");
  });

  it("redacts a github_pat_-shaped value as opaque with no prefix leak", async () => {
    const handler = makeHandler();
    // Synthetic fine-grained PAT shape: github_pat_<22>_<59>.
    const value = "github_pat_" + "A".repeat(22) + "_" + "B".repeat(59);

    const err = await captureRejection(() =>
      handler.resolve({ secretRef: value }),
    );

    expect(err.name).toBe("InvalidSecretRefError");
    expect(err.message).toContain("kind=opaque");
    expect(err.message).toContain(`len=${value.length}`);
    expect(err.message).not.toContain(value);
    expect(err.message).not.toContain("github_pat_");
  });

  it("redacts a Bearer header value as opaque with no value leak", async () => {
    const handler = makeHandler();
    const value = "Bearer " + "x".repeat(48);

    const err = await captureRejection(() =>
      handler.resolve({ secretRef: value }),
    );

    expect(err.name).toBe("InvalidSecretRefError");
    expect(err.message).toContain("kind=opaque");
    expect(err.message).toContain(`len=${value.length}`);
    expect(err.message).not.toContain(value);
    // The literal "Bearer " prefix is suggestive enough that it must not
    // round-trip into the error text either.
    expect(err.message).not.toContain("Bearer ");
  });

  it("describes empty / null / non-string inputs without echoing them", async () => {
    {
      const handler = makeHandler();
      const err = await captureRejection(() =>
        handler.resolve({ secretRef: "" }),
      );
      expect(err.name).toBe("InvalidSecretRefError");
      expect(err.message).toMatch(/kind=(empty|whitespace)/);
    }
    {
      const handler = makeHandler();
      const err = await captureRejection(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler.resolve({ secretRef: null as any }),
      );
      expect(err.name).toBe("InvalidSecretRefError");
      expect(err.message).toContain("kind=null");
      expect(err.message).not.toContain("<empty>");
    }
    {
      const handler = makeHandler();
      const err = await captureRejection(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler.resolve({ secretRef: undefined as any }),
      );
      expect(err.name).toBe("InvalidSecretRefError");
      // Either "kind=undefined" (non-string path) or empty-equivalent —
      // both are acceptable; the invariant is "no raw value echo".
      expect(err.message).toMatch(/kind=(undefined|empty)/);
    }
    {
      const handler = makeHandler();
      const err = await captureRejection(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler.resolve({ secretRef: 42 as any }),
      );
      expect(err.name).toBe("InvalidSecretRefError");
      expect(err.message).toContain("kind=non-string");
      expect(err.message).toContain("type=number");
      expect(err.message).not.toContain("42");
    }
  });
});
