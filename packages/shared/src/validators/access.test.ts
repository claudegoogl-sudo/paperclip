import { describe, expect, it } from "vitest";
import { authSessionSchema, createBoardApiKeySchema, currentUserProfileSchema } from "./access.js";

describe("currentUserProfileSchema", () => {
  it("coerces empty-string name to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe(null);
  });

  it("coerces whitespace-only name to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "   ",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe(null);
  });

  it("preserves a real name unchanged", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe("Jane");
  });

  it("preserves null name as null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: null,
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe(null);
  });

  it("coerces empty-string email to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe(null);
  });

  it("coerces whitespace-only email to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "   ",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe(null);
  });

  it("preserves a real email unchanged", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe("a@b.com");
  });

  it("preserves null email as null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: null,
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe(null);
  });

  it("still rejects a malformed non-empty email", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "not-an-email",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("authSessionSchema", () => {
  it("parses a session where user name is empty string (identity provider without a name)", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "", image: null },
      sentryDsn: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.name).toBe(null);
  });

  it("parses a session where user has a real name", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
      sentryDsn: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.name).toBe("Jane");
  });

  it("parses a session where user name is null", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: null, image: null },
      sentryDsn: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.name).toBe(null);
  });

  it("parses a session where user email is empty string (identity provider without an email)", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "", name: "Jane", image: null },
      sentryDsn: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.email).toBe(null);
  });

  it("rejects a payload with no sentryDsn field", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a null sentryDsn", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
      sentryDsn: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.sentryDsn).toBe(null);
  });

  it("accepts a real sentryDsn value", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
      sentryDsn: "https://public@o0.ingest.sentry.io/1",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.sentryDsn).toBe("https://public@o0.ingest.sentry.io/1");
  });
});


describe("createBoardApiKeySchema", () => {
  const soon = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it("rejects a request with only a name (expiresAt and scope both required)", () => {
    const result = createBoardApiKeySchema.safeParse({ name: "cli-board" });
    expect(result.success).toBe(false);
  });

  it("rejects expiresAt: null", () => {
    const result = createBoardApiKeySchema.safeParse({
      name: "cli-board",
      expiresAt: null,
      scope: { kind: "plugin_ops" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects scope: null", () => {
    const result = createBoardApiKeySchema.safeParse({
      name: "cli-board",
      expiresAt: soon(),
      scope: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a plugin_ops key requesting an expiry beyond the 90-day max TTL", () => {
    const farFuture = new Date(Date.now() + 91 * 24 * 60 * 60 * 1000).toISOString();
    const result = createBoardApiKeySchema.safeParse({
      name: "cli-board",
      expiresAt: farFuture,
      scope: { kind: "plugin_ops" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a plugin_ops key within the 90-day max TTL", () => {
    const within = new Date(Date.now() + 89 * 24 * 60 * 60 * 1000).toISOString();
    const result = createBoardApiKeySchema.safeParse({
      name: "cli-board",
      expiresAt: within,
      scope: { kind: "plugin_ops" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a standard (full-authority) scope key with a TTL longer than 24 hours", () => {
    const twoDays = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const result = createBoardApiKeySchema.safeParse({
      name: "cli-board",
      expiresAt: twoDays,
      scope: { kind: "standard" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a standard (full-authority) scope key with a short TTL", () => {
    const oneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = createBoardApiKeySchema.safeParse({
      name: "cli-board",
      expiresAt: oneHour,
      scope: { kind: "standard" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an expiresAt in the past", () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = createBoardApiKeySchema.safeParse({
      name: "cli-board",
      expiresAt: past,
      scope: { kind: "plugin_ops" },
    });
    expect(result.success).toBe(false);
  });
});
