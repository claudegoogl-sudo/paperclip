import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, companies, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logActivity } from "../services/activity-log.ts";
import { runWithActorProvenance } from "../middleware/actor-context.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping activity-log actor provenance tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("logActivity actor provenance (AC5)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-provenance-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function logUnder(
    provenance: { source: string | null; keyId: string | null } | null,
    action: string,
  ) {
    const write = () =>
      logActivity(db, {
        companyId,
        actorType: "user",
        actorId: "operator",
        action,
        entityType: "company",
        entityId: companyId,
      });
    if (provenance) {
      await runWithActorProvenance(provenance, write);
    } else {
      await write();
    }
  }

  it("records board_key source and keyId distinctly from an interactive session", async () => {
    const boardKeyId = randomUUID();
    await logUnder({ source: "board_key", keyId: boardKeyId }, "test.board_key_write");
    await logUnder({ source: "session", keyId: null }, "test.session_write");
    await logUnder(null, "test.background_write");

    const rows = await db
      .select({
        action: activityLog.action,
        actorSource: activityLog.actorSource,
        actorKeyId: activityLog.actorKeyId,
      })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    const byAction = new Map(rows.map((r) => [r.action, r]));

    // A board-key-authenticated write is now distinguishable after the fact.
    expect(byAction.get("test.board_key_write")).toMatchObject({
      actorSource: "board_key",
      actorKeyId: boardKeyId,
    });
    // An interactive dashboard click carries source but no board credential id.
    expect(byAction.get("test.session_write")).toMatchObject({
      actorSource: "session",
      actorKeyId: null,
    });
    // Background work (no request context) carries neither — itself meaningful.
    expect(byAction.get("test.background_write")).toMatchObject({
      actorSource: null,
      actorKeyId: null,
    });

    // The provenance fields differ exactly as the two credential classes should.
    expect(byAction.get("test.board_key_write")?.actorSource).not.toBe(
      byAction.get("test.session_write")?.actorSource,
    );
  });
});
