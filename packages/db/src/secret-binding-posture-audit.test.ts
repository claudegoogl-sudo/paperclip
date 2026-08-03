import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Regression coverage for migration 0144.
//
// The vulnerability being encoded: on 2026-08-03 a re-run of migration 0138
// executed `UPDATE company_secret_bindings SET egress_allowlist_enforced = false`
// and cleared borrowed-handle egress enforcement on every row, leaving NO trace
// anywhere in the product. It was reconstructable only from `xmin`, which VACUUM
// destroys. These cases assert that a write from a NON-application path — raw
// SQL on a plain connection, exactly like the migration runner — is recorded.
//
// Against pre-0144 code every case here fails: the audit table does not exist.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping secret-binding-posture-audit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type AuditRow = {
  binding_id: string;
  company_id: string;
  op: string;
  old_enforced: boolean | null;
  new_enforced: boolean | null;
  old_allowed_egress: string[] | null;
  new_allowed_egress: string[] | null;
  txid: string;
  db_user: string;
  changed_at: Date;
};

describeEmbeddedPostgres("0144 company_secret_binding_posture_audit", () => {
  let cleanup: () => Promise<void>;
  let sql: ReturnType<typeof postgres>;

  const companyId = randomUUID();
  let secretId: string;

  beforeAll(async () => {
    const db = await startEmbeddedPostgresTestDatabase("paperclip-pla2121-posture-");
    cleanup = db.cleanup;
    sql = postgres(db.connectionString, { max: 1, onnotice: () => {} });
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Tenant', 'PLA2121')`;
    secretId = randomUUID();
    await sql`INSERT INTO company_secrets (id, company_id, key, name)
      VALUES (${secretId}, ${companyId}, 'githubPat', 'githubPat')`;
  });

  afterAll(async () => {
    await sql?.end();
    await cleanup?.();
  });

  beforeEach(async () => {
    await sql`DELETE FROM company_secret_bindings`;
  });

  async function insertBinding(configPath: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO company_secret_bindings
        (id, company_id, secret_id, target_type, target_id, config_path)
      VALUES (${id}, ${companyId}, ${secretId}, 'agent', ${randomUUID()}, ${configPath})`;
    return id;
  }

  async function auditFor(bindingId: string): Promise<AuditRow[]> {
    return (await sql`
      SELECT binding_id, company_id, op, old_enforced, new_enforced,
             old_allowed_egress, new_allowed_egress, txid, db_user, changed_at
      FROM company_secret_binding_posture_audit
      WHERE binding_id = ${bindingId}
      ORDER BY changed_at, op
    `) as unknown as AuditRow[];
  }

  it("records the born-enforcing state of a newly inserted binding", async () => {
    const bindingId = await insertBinding("env.GITHUB_PAT");

    const rows = await auditFor(bindingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.op).toBe("insert");
    expect(rows[0]?.old_enforced).toBeNull();
    // The column DEFAULT: every new binding is born enforcing with an empty
    // allowlist, i.e. deny-all for that secret.
    expect(rows[0]?.new_enforced).toBe(true);
    expect(rows[0]?.new_allowed_egress).toEqual([]);
    expect(rows[0]?.txid).toMatch(/^\d+$/);
    expect(rows[0]?.db_user).not.toBe("");
  });

  it("records a blanket enforcement clear issued outside application code", async () => {
    const bindingId = await insertBinding("env.GITHUB_PAT");

    // Byte-for-byte the statement from the tail of migration 0138 that caused
    // the incident: no WHERE, no application involvement.
    await sql.unsafe(`UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false`);

    const rows = await auditFor(bindingId);
    expect(rows).toHaveLength(2);
    const update = rows[1];
    expect(update?.op).toBe("update");
    expect(update?.old_enforced).toBe(true);
    expect(update?.new_enforced).toBe(false);
    // The forensic fields that replace the perishable `xmin` reconstruction.
    expect(update?.txid).toMatch(/^\d+$/);
    expect(update?.txid).not.toBe(rows[0]?.txid);
  });

  it("records allowlist changes, because the flag alone is uninterpretable", async () => {
    const bindingId = await insertBinding("env.GITHUB_PAT");

    await sql`UPDATE company_secret_bindings
      SET allowed_egress = ${sql.array(["https://api.github.com"])}
      WHERE id = ${bindingId}`;

    const rows = await auditFor(bindingId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.old_allowed_egress).toEqual([]);
    expect(rows[1]?.new_allowed_egress).toEqual(["https://api.github.com"]);
    expect(rows[1]?.new_enforced).toBe(true);
  });

  it("does not record writes that leave the posture pair unchanged", async () => {
    const bindingId = await insertBinding("env.GITHUB_PAT");

    await sql`UPDATE company_secret_bindings SET label = 'renamed' WHERE id = ${bindingId}`;
    await sql`UPDATE company_secret_bindings
      SET egress_allowlist_enforced = true WHERE id = ${bindingId}`;

    expect(await auditFor(bindingId)).toHaveLength(1);
  });

  it("keeps a deleted binding's history", async () => {
    const bindingId = await insertBinding("env.GITHUB_PAT");
    await sql`DELETE FROM company_secret_bindings WHERE id = ${bindingId}`;

    const rows = await auditFor(bindingId);
    expect(rows.map((row) => row.op)).toEqual(["insert", "delete"]);
    expect(rows[1]?.old_enforced).toBe(true);
    expect(rows[1]?.new_enforced).toBeNull();
  });

  it("rejects UPDATE, DELETE and TRUNCATE on the audit table", async () => {
    const bindingId = await insertBinding("env.GITHUB_PAT");
    expect(await auditFor(bindingId)).toHaveLength(1);

    await expect(
      sql`UPDATE company_secret_binding_posture_audit
        SET new_enforced = false WHERE binding_id = ${bindingId}`,
    ).rejects.toThrow(/append-only/);

    await expect(
      sql`DELETE FROM company_secret_binding_posture_audit WHERE binding_id = ${bindingId}`,
    ).rejects.toThrow(/append-only/);

    await expect(
      sql.unsafe(`TRUNCATE TABLE "company_secret_binding_posture_audit"`),
    ).rejects.toThrow(/append-only/);

    expect(await auditFor(bindingId)).toHaveLength(1);
  });
});
