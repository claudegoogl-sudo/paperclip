/**
 * PLA-734 — would-deny egress harvest STORE (option b), against a real DB.
 *
 * Pins the SE constraints that live in the store: upsert-dedupe (one row per
 * (binding, origin); repeat bumps count + last_seen), per-binding cardinality
 * cap (top-N by count), and the company-scoped (BOLA-safe) read path.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySecretBindings,
  companySecrets,
  createDb,
  egressWouldDenyObservations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  MAX_ORIGINS_PER_BINDING,
  listEgressWouldDeny,
  recordEgressWouldDeny,
} from "../services/egress-harvest.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping PLA-734 harvest store tests: ${support.reason ?? "unsupported environment"}`);
}

describeDb("PLA-734 egress harvest store", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-egress-harvest-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(egressWouldDenyObservations);
    await db.delete(companySecretBindings);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedBinding(companyId: string): Promise<string> {
    await db
      .insert(companies)
      .values({
        id: companyId,
        name: `co-${companyId.slice(0, 8)}`,
        // issue_prefix is UNIQUE (defaults to "PAP") — give each seeded company
        // a distinct prefix so multiple companies can coexist in one test.
        issuePrefix: companyId.slice(0, 6).toUpperCase(),
      })
      .onConflictDoNothing();
    const secretId = randomUUID();
    await db.insert(companySecrets).values({
      id: secretId,
      companyId,
      key: `k-${secretId.slice(0, 8)}`,
      name: `n-${secretId.slice(0, 8)}`,
    });
    const bindingId = randomUUID();
    await db.insert(companySecretBindings).values({
      id: bindingId,
      companyId,
      secretId,
      targetType: "agent",
      targetId: `t-${bindingId.slice(0, 8)}`,
      configPath: `cfg.${bindingId.slice(0, 8)}`,
    });
    return bindingId;
  }

  it("upsert-dedupe: a repeat (binding, origin) bumps count, not a new row", async () => {
    const companyId = randomUUID();
    const bindingId = await seedBinding(companyId);

    await recordEgressWouldDeny(db, { companyId, bindingIds: [bindingId], origin: "https://attacker.com" });
    await recordEgressWouldDeny(db, { companyId, bindingIds: [bindingId], origin: "https://attacker.com" });
    await recordEgressWouldDeny(db, { companyId, bindingIds: [bindingId], origin: "https://attacker.com" });
    // A different origin under the same binding is a distinct row.
    await recordEgressWouldDeny(db, { companyId, bindingIds: [bindingId], origin: "https://evil.test" });

    const rows = await listEgressWouldDeny(db, { companyId, bindingId });
    expect(rows).toHaveLength(2);
    const attacker = rows.find((r) => r.origin === "https://attacker.com")!;
    expect(attacker.count).toBe(3);
    expect(attacker.lastSeen.getTime()).toBeGreaterThanOrEqual(attacker.firstSeen.getTime());
    expect(rows.find((r) => r.origin === "https://evil.test")!.count).toBe(1);
    // Ordered most-frequent first.
    expect(rows[0].origin).toBe("https://attacker.com");
  });

  it("cardinality cap: a binding keeps at most MAX_ORIGINS_PER_BINDING origins (top-N by count)", async () => {
    const companyId = randomUUID();
    const bindingId = await seedBinding(companyId);

    // Give one origin a high count so it must survive the cap, then flood with
    // many single-hit origins to exceed the cap.
    const hot = "https://hot.example";
    for (let i = 0; i < 5; i++) {
      await recordEgressWouldDeny(db, { companyId, bindingIds: [bindingId], origin: hot });
    }
    const flood = MAX_ORIGINS_PER_BINDING + 20;
    for (let i = 0; i < flood; i++) {
      await recordEgressWouldDeny(db, {
        companyId,
        bindingIds: [bindingId],
        origin: `https://flood-${i}.example`,
      });
    }

    const rows = await listEgressWouldDeny(db, { companyId, bindingId });
    expect(rows.length).toBe(MAX_ORIGINS_PER_BINDING);
    // The high-count origin is never pruned.
    expect(rows.some((r) => r.origin === hot && r.count === 5)).toBe(true);
  });

  it("company-scoped read (BOLA): never returns another company's observations", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const bindingA = await seedBinding(companyA);
    const bindingB = await seedBinding(companyB);

    await recordEgressWouldDeny(db, { companyId: companyA, bindingIds: [bindingA], origin: "https://a.example" });
    await recordEgressWouldDeny(db, { companyId: companyB, bindingIds: [bindingB], origin: "https://b.example" });

    const aRows = await listEgressWouldDeny(db, { companyId: companyA });
    expect(aRows.map((r) => r.origin)).toEqual(["https://a.example"]);

    const bRows = await listEgressWouldDeny(db, { companyId: companyB });
    expect(bRows.map((r) => r.origin)).toEqual(["https://b.example"]);

    // Scoping a read to company A by company B's binding id yields nothing.
    expect(await listEgressWouldDeny(db, { companyId: companyA, bindingId: bindingB })).toHaveLength(0);
  });

  it("a single call dedupes binding ids and records each origin once", async () => {
    const companyId = randomUUID();
    const bindingId = await seedBinding(companyId);
    await recordEgressWouldDeny(db, {
      companyId,
      bindingIds: [bindingId, bindingId, bindingId],
      origin: "https://dup.example",
    });
    const rows = await listEgressWouldDeny(db, { companyId, bindingId });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
  });
});
