import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, usageLimitPark } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { usageLimitParkService } from "../services/usage-limit-park.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres usage-limit-park tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("usageLimitParkService", () => {
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof usageLimitParkService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-usage-limit-park-");
    db = createDb(tempDb.connectionString);
    service = usageLimitParkService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(usageLimitPark);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns null when no park row exists", async () => {
    expect(await service.getPark()).toBeNull();
  });

  it("returns the active park after setPark with a future time", async () => {
    const parkedUntil = new Date(Date.now() + 60_000);
    const sourceRunId = randomUUID();
    const sourceAgentId = randomUUID();
    const sourceCompanyId = randomUUID();
    await service.setPark({
      parkedUntil,
      reason: "claude_usage_limit",
      rawText: "You've hit your weekly limit · resets 8am (UTC)",
      sourceRunId,
      sourceAgentId,
      sourceCompanyId,
    });

    const park = await service.getPark();
    expect(park).not.toBeNull();
    expect(park?.parkedUntil.getTime()).toBe(parkedUntil.getTime());
    expect(park?.reason).toBe("claude_usage_limit");
    expect(park?.rawText).toBe("You've hit your weekly limit · resets 8am (UTC)");
    expect(park?.sourceRunId).toBe(sourceRunId);
    expect(park?.sourceAgentId).toBe(sourceAgentId);
    expect(park?.sourceCompanyId).toBe(sourceCompanyId);
  });

  it("does not shrink an already-active, later park with an earlier setPark", async () => {
    const laterParkedUntil = new Date(Date.now() + 120_000);
    await service.setPark({
      parkedUntil: laterParkedUntil,
      reason: "claude_usage_limit",
      rawText: null,
      sourceRunId: null,
      sourceAgentId: null,
      sourceCompanyId: null,
    });

    const earlierParkedUntil = new Date(Date.now() + 30_000);
    await service.setPark({
      parkedUntil: earlierParkedUntil,
      reason: "claude_usage_limit",
      rawText: "a straggler run's earlier classification",
      sourceRunId: null,
      sourceAgentId: null,
      sourceCompanyId: null,
    });

    const park = await service.getPark();
    // GREATEST(existing, incoming) semantics: the earlier straggler cannot
    // shrink the already-active, later park.
    expect(park?.parkedUntil.getTime()).toBe(laterParkedUntil.getTime());
  });

  it("extends an active park when setPark is called with a later time", async () => {
    const firstParkedUntil = new Date(Date.now() + 30_000);
    await service.setPark({
      parkedUntil: firstParkedUntil,
      reason: "claude_usage_limit",
      rawText: null,
      sourceRunId: null,
      sourceAgentId: null,
      sourceCompanyId: null,
    });

    const laterParkedUntil = new Date(Date.now() + 90_000);
    await service.setPark({
      parkedUntil: laterParkedUntil,
      reason: "claude_usage_limit",
      rawText: null,
      sourceRunId: null,
      sourceAgentId: null,
      sourceCompanyId: null,
    });

    const park = await service.getPark();
    expect(park?.parkedUntil.getTime()).toBe(laterParkedUntil.getTime());
  });

  it("treats a park whose parkedUntil is in the past as inactive", async () => {
    const pastParkedUntil = new Date(Date.now() - 60_000);
    await service.setPark({
      parkedUntil: pastParkedUntil,
      reason: "claude_usage_limit",
      rawText: null,
      sourceRunId: null,
      sourceAgentId: null,
      sourceCompanyId: null,
    });

    expect(await service.getPark()).toBeNull();
  });

  it("clears an active park so getPark returns null afterward", async () => {
    await service.setPark({
      parkedUntil: new Date(Date.now() + 60_000),
      reason: "claude_usage_limit",
      rawText: null,
      sourceRunId: null,
      sourceAgentId: null,
      sourceCompanyId: null,
    });
    expect(await service.getPark()).not.toBeNull();

    await service.clearPark("run_succeeded");
    expect(await service.getPark()).toBeNull();
  });
});
