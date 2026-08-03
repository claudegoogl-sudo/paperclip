import { readFileSync } from "node:fs";
import { boolean, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  analyzeMigrationSafety,
  assertSecurityBaselineReasons,
  runMigrationSafetyCheck,
  type MigrationSafetyInput,
} from "./check-migration-safety.js";
import { MIGRATION_SAFETY_BASELINE } from "./migration-safety-baseline.js";
import {
  assertSecurityPostureColumnsResolve,
  SECURITY_POSTURE_COLUMNS,
  type SecurityPostureColumn,
} from "./security-posture-columns.js";
import {
  TABLE_SIZE_ESTIMATE_FACTOR,
  TABLE_SIZE_BUCKET_THRESHOLDS,
  type TableSizeEstimate,
} from "./table-size-estimates.js";

const testEstimates: readonly TableSizeEstimate[] = [
  {
    table: "issue_comments",
    localRows: 5_034,
    estimateFactor: TABLE_SIZE_ESTIMATE_FACTOR,
    estimatedRows: 5_034 * TABLE_SIZE_ESTIMATE_FACTOR,
    bucket: "large",
  },
  {
    table: "companies",
    localRows: 1,
    estimateFactor: TABLE_SIZE_ESTIMATE_FACTOR,
    estimatedRows: TABLE_SIZE_ESTIMATE_FACTOR,
    bucket: "small",
  },
];

function analyze(sql: string) {
  const migrations: readonly MigrationSafetyInput[] = [{ fileName: "9999_fixture.sql", sql }];
  return analyzeMigrationSafety(migrations, { baselineIds: [], estimates: testEstimates });
}

describe("migration safety check", () => {
  it("documents the large table threshold used by the estimates", () => {
    expect(TABLE_SIZE_BUCKET_THRESHOLDS.largeRows).toBe(1_000_000);
    expect(testEstimates[0]?.estimatedRows).toBeGreaterThanOrEqual(
      TABLE_SIZE_BUCKET_THRESHOLDS.largeRows,
    );
  });

  it("fails a 0126-shaped batched loop over a large table without a support index", () => {
    const result = analyze(`
      DO $$
      DECLARE
        last_comment_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
      BEGIN
        LOOP
          WITH batch AS MATERIALIZED (
            SELECT c."id"
            FROM "issue_comments" c
            WHERE c."id" > last_comment_id
              AND c."author_agent_id" IS NULL
            ORDER BY c."id"
            LIMIT 5000
          )
          UPDATE "issue_comments" c
          SET "derived_author_agent_id" = NULL
          FROM batch b
          WHERE c."id" = b."id";

          EXIT WHEN NOT FOUND;
        END LOOP;
      END $$;
    `);

    expect(result.newFindings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        "loop-mutation-large-table",
        "batched-mutation-large-table-missing-index",
      ]),
    );
    expect(result.newFindings[0]?.table).toBe("issue_comments");
  });

  it("passes the same bounded large-table backfill when a matching concurrent support index exists", () => {
    const result = analyze(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_fixture_backfill_idx"
        ON "issue_comments" USING btree ("id")
        WHERE "author_agent_id" IS NULL;--> statement-breakpoint
      DO $$
      DECLARE
        last_comment_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
      BEGIN
        LOOP
          WITH batch AS MATERIALIZED (
            SELECT c."id"
            FROM "issue_comments" c
            WHERE c."id" > last_comment_id
              AND c."author_agent_id" IS NULL
            ORDER BY c."id"
            LIMIT 5000
          )
          UPDATE "issue_comments" c
          SET "derived_author_agent_id" = NULL
          FROM batch b
          WHERE c."id" = b."id";

          EXIT WHEN NOT FOUND;
        END LOOP;
      END $$;
    `);

    expect(result.newFindings).toEqual([]);
  });

  it("does not suppress missing-index finding when a partial support index predicate is incompatible with the batch WHERE", () => {
    const result = analyze(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_fixture_backfill_idx"
        ON "issue_comments" USING btree ("id")
        WHERE "author_agent_id" IS NOT NULL;--> statement-breakpoint
      DO $$
      DECLARE
        last_comment_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
      BEGIN
        LOOP
          WITH batch AS MATERIALIZED (
            SELECT c."id"
            FROM "issue_comments" c
            WHERE c."id" > last_comment_id
              AND c."author_agent_id" IS NULL
            ORDER BY c."id"
            LIMIT 5000
          )
          UPDATE "issue_comments" c
          SET "derived_author_agent_id" = NULL
          FROM batch b
          WHERE c."id" = b."id";

          EXIT WHEN NOT FOUND;
        END LOOP;
      END $$;
    `);

    expect(result.newFindings.map((finding) => finding.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("passes a batched backfill over a small-bucket table", () => {
    const result = analyze(`
      DO $$
      BEGIN
        LOOP
          WITH batch AS (
            SELECT "id"
            FROM "companies"
            ORDER BY "id"
            LIMIT 100
          )
          UPDATE "companies" c
          SET "description" = c."description"
          FROM batch b
          WHERE c."id" = b."id";

          EXIT WHEN NOT FOUND;
        END LOOP;
      END $$;
    `);

    expect(result.newFindings).toEqual([]);
  });

  it("flags UPDATE ... FROM (SELECT ... LIMIT N) subquery batch on a large table", () => {
    const result = analyze(`
      UPDATE "issue_comments" c
      SET "derived_author_agent_id" = NULL
      FROM (
        SELECT "id"
        FROM "issue_comments"
        WHERE "author_agent_id" IS NULL
        ORDER BY "id"
        LIMIT 5000
      ) batch
      WHERE c."id" = batch."id";
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags UPDATE ... FROM (SELECT ... FETCH FIRST N ROWS ONLY) subquery batch on a large table", () => {
    const result = analyze(`
      UPDATE "issue_comments" c
      SET "derived_author_agent_id" = NULL
      FROM (
        SELECT "id"
        FROM "issue_comments"
        WHERE "author_agent_id" IS NULL
        ORDER BY "id"
        FETCH FIRST 5000 ROWS ONLY
      ) batch
      WHERE c."id" = batch."id";
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags UPDATE ... FROM (SELECT ... FETCH NEXT N ROWS ONLY) subquery batch on a large table", () => {
    const result = analyze(`
      UPDATE "issue_comments" c
      SET "derived_author_agent_id" = NULL
      FROM (
        SELECT "id"
        FROM "issue_comments"
        WHERE "author_agent_id" IS NULL
        ORDER BY "id"
        FETCH NEXT 5000 ROWS ONLY
      ) batch
      WHERE c."id" = batch."id";
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags UPDATE ... FROM (SELECT ... FETCH FIRST N ROWS WITH TIES) subquery batch on a large table", () => {
    const result = analyze(`
      UPDATE "issue_comments" c
      SET "derived_author_agent_id" = NULL
      FROM (
        SELECT "id"
        FROM "issue_comments"
        WHERE "author_agent_id" IS NULL
        ORDER BY "id"
        FETCH FIRST 5000 ROWS WITH TIES
      ) batch
      WHERE c."id" = batch."id";
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags UPDATE ... FROM (SELECT ... FETCH FIRST ROW ONLY) subquery batch on a large table", () => {
    const result = analyze(`
      UPDATE "issue_comments" c
      SET "derived_author_agent_id" = NULL
      FROM (
        SELECT "id"
        FROM "issue_comments"
        WHERE "author_agent_id" IS NULL
        ORDER BY "id"
        FETCH FIRST ROW ONLY
      ) batch
      WHERE c."id" = batch."id";
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags UPDATE ... WHERE IN (SELECT ... LIMIT N) subquery batch on a large table", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "derived_author_agent_id" = NULL
      WHERE "id" IN (
        SELECT "id"
        FROM "issue_comments"
        WHERE "author_agent_id" IS NULL
        ORDER BY "id"
        LIMIT 5000
      );
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags a CTE with a selective WHERE when the outer UPDATE has no WHERE clause", () => {
    const result = analyze(`
      WITH selective AS (
        SELECT "id" FROM "issue_comments" WHERE "author_agent_id" IS NULL
      )
      UPDATE "issue_comments"
      SET "derived_author_agent_id" = NULL
      FROM selective;
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not treat WHERE inside a block comment as a selective predicate", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "derived_author_agent_id" = NULL /* ignored
        /* nested WHERE "id" > '0' */
        still ignored
      */;
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not treat WHERE inside an inline line comment as a selective predicate", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "derived_author_agent_id" = NULL -- WHERE "id" > '0'
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not treat WHERE inside a string literal as a selective predicate", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "body" = 'WHERE "id" > ''0''';
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not treat WHERE inside a tagged dollar-quoted string as a selective predicate", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "body" = $msg$WHERE "id" > '0'$msg$;
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not treat WHERE inside an untagged dollar-quoted string as a selective predicate", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "body" = $$WHERE "id" > '0'$$;
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("still accepts a real selective WHERE clause", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "derived_author_agent_id" = NULL
      WHERE "id" > '0';
    `);

    expect(result.newFindings.map((f) => f.rule)).not.toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not suppress full-table finding when WHERE only constrains a joined table", () => {
    const result = analyze(`
      UPDATE "issue_comments"
        SET "derived_author_agent_id" = NULL
        FROM "companies"
        WHERE "companies"."id" = '00000000-0000-0000-0000-000000000000';
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not suppress full-table finding when WHERE only constrains a joined table via an unquoted alias", () => {
    const result = analyze(`
      UPDATE "issue_comments"
        SET "derived_author_agent_id" = NULL
        FROM "companies" c
        WHERE c."id" = '00000000-0000-0000-0000-000000000000';
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not suppress full-table finding when WHERE only constrains an unquoted joined table", () => {
    const result = analyze(`
      UPDATE "issue_comments"
        SET "derived_author_agent_id" = NULL
        FROM companies
        WHERE companies.id = '00000000-0000-0000-0000-000000000000';
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not suppress missing-index finding when support index uses an expression", () => {
    const result = analyze(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_expr_idx"
        ON "issue_comments" ((lower("body")));--> statement-breakpoint
      UPDATE "issue_comments" c
        SET "derived_author_agent_id" = NULL
        FROM (
          SELECT "id"
          FROM "issue_comments"
          ORDER BY "id"
          LIMIT 5000
        ) b
        WHERE c."id" = b."id";
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags a batch backfill when the support index does not cover the ORDER BY key", () => {
    const result = analyze(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_author_idx"
        ON "issue_comments" ("author_agent_id");--> statement-breakpoint
      DO $$
      DECLARE
        last_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
      BEGIN
        LOOP
          WITH batch AS MATERIALIZED (
            SELECT "id"
            FROM "issue_comments"
            WHERE "id" > last_id
            ORDER BY "id"
            LIMIT 5000
          )
          UPDATE "issue_comments" c
          SET "derived_author_agent_id" = NULL
          FROM batch b
          WHERE c."id" = b."id";

          EXIT WHEN NOT FOUND;
        END LOOP;
      END $$;
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags a batch backfill when the support index only covers a later ORDER BY column", () => {
    const result = analyze(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_created_idx"
        ON "issue_comments" ("created_at");--> statement-breakpoint
      DO $$
      DECLARE
        last_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
      BEGIN
        LOOP
          WITH batch AS MATERIALIZED (
            SELECT "id"
            FROM "issue_comments"
            WHERE "id" > last_id
            ORDER BY "id", "created_at"
            LIMIT 5000
          )
          UPDATE "issue_comments" c
          SET "derived_author_agent_id" = NULL
          FROM batch b
          WHERE c."id" = b."id";

          EXIT WHEN NOT FOUND;
        END LOOP;
      END $$;
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("honors suppressions only when they name a rule and reason", () => {
    const result = analyze(`
      -- paperclip:migration-safety-ignore full-table-mutation-large-table: one-time metadata reset approved in issue thread
      UPDATE "issue_comments"
      SET "derived_author_source" = NULL;
    `);

    expect(result.newFindings).toEqual([]);
  });
});

const POSTURE_RULE = "unqualified-mutation-security-posture-column";
const MIGRATION_0138 = "0138_secret_binding_egress_allowlist.sql";

function postureFindings(sql: string) {
  return analyze(sql).newFindings.filter((finding) => finding.rule === POSTURE_RULE);
}

describe("unqualified mutation of a security-posture column", () => {
  // The regression test that matters: the real historical statement, read off
  // disk, not a synthetic reconstruction of it.
  const migration0138 = readFileSync(
    new URL(`./migrations/${MIGRATION_0138}`, import.meta.url),
    "utf8",
  );

  it("fires as an error on the real 0138 text that flattened every binding", () => {
    const result = analyzeMigrationSafety([{ fileName: MIGRATION_0138, sql: migration0138 }], {
      baselineIds: [],
      estimates: testEstimates,
    });

    const finding = result.newFindings.find((entry) => entry.rule === POSTURE_RULE);
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("error");
    expect(finding?.table).toBe("company_secret_bindings");
    expect(finding?.message).toContain("egress_allowlist_enforced");
    expect(finding?.statement).toContain('UPDATE "company_secret_bindings"');
  });

  it("does not lean on a migration's own claim that its write runs once", () => {
    // 0138's header used to assert "The UPDATE runs once (drizzle journal-gated)"
    // and the re-run that flattened the flag disproved it. That header has since
    // been rewritten, so the claim is pinned here as a fixture rather than read
    // off 0138: the property under test is that the rule scores the statement,
    // never the migration's narration of its own execution. Asserting on 0138's
    // prose coupled this test to a comment and broke it when the prose was fixed.
    const claimsRunOnce = `
      -- The UPDATE runs once (drizzle journal-gated); new rows are untouched.
      UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false;
    `;
    expect(postureFindings(claimsRunOnce)).toHaveLength(1);

    // The live file still has to produce exactly one finding, whatever its header
    // says today -- that is the half of the old assertion worth keeping.
    expect(postureFindings(migration0138)).toHaveLength(1);
  });

  it("keeps 0138 green in CI through a baseline entry that states a reason", () => {
    const result = analyzeMigrationSafety([{ fileName: MIGRATION_0138, sql: migration0138 }], {
      estimates: testEstimates,
    });
    expect(result.newFindings).toEqual([]);
    expect(result.baselineFindings.map((entry) => entry.rule)).toContain(POSTURE_RULE);

    const entry = MIGRATION_SAFETY_BASELINE.find((candidate) => candidate.rule === POSTURE_RULE);
    expect(entry?.migration).toBe(MIGRATION_0138);
    expect(entry?.reason.trim().length).toBeGreaterThan(20);
  });

  it("covers the in-flight rewrite of 0138 so either merge order stays green", () => {
    // A separate change rewrites 0138's rollout UPDATE into a DO block gated on
    // whether that run created the column. The finding id hashes the normalized
    // statement, so the rewrite produces a different id — whichever change lands
    // second would go red on an uncovered finding. Both texts are baselined.
    // The rule still fires on the rewritten form by design: it recognises a
    // selective WHERE, not an arbitrary PL/pgSQL guard.
    const rewritten = `
      DO $$
      DECLARE
        column_existed boolean;
      BEGIN
        SELECT EXISTS (
          SELECT 1
          FROM pg_attribute
          WHERE attrelid = to_regclass('"company_secret_bindings"')
            AND attname = 'egress_allowlist_enforced'
            AND attnum > 0
            AND NOT attisdropped
        ) INTO column_existed;

        ALTER TABLE "company_secret_bindings"
          ADD COLUMN IF NOT EXISTS "egress_allowlist_enforced" boolean DEFAULT true NOT NULL;

        IF NOT column_existed THEN
          UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false;
        END IF;
      END
      $$;
    `;
    expect(postureFindings(rewritten)).toHaveLength(1);

    const result = analyzeMigrationSafety([{ fileName: MIGRATION_0138, sql: rewritten }], {
      estimates: testEstimates,
    });
    expect(result.newFindings).toEqual([]);
  });

  it("rejects a baseline that silences a security rule without a reason", () => {
    expect(() => assertSecurityBaselineReasons()).not.toThrow();
    expect(() =>
      assertSecurityBaselineReasons([
        { id: "deadbeefdeadbeef", rule: POSTURE_RULE, reason: "   " },
      ]),
    ).toThrow(/no reason/);
  });

  it("ignores row count: the registry, not the size bucket, decides", () => {
    // company_secret_bindings is absent from TABLE_SIZE_ESTIMATES and holds four
    // rows, so every size-gated rule skips it. This rule must not.
    const findings = postureFindings(
      `UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false;`,
    );
    expect(findings).toHaveLength(1);
    expect(analyze(`UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false;`)
      .newFindings.map((entry) => entry.rule))
      .toEqual([POSTURE_RULE]);
  });

  it("stays silent on a genuinely selective write", () => {
    expect(
      postureFindings(`
        UPDATE "company_secret_bindings"
        SET "egress_allowlist_enforced" = false
        WHERE "company_id" = '00000000-0000-0000-0000-000000000000';
      `),
    ).toEqual([]);
  });

  it("stays silent on a non-registered column of a registered table", () => {
    expect(
      postureFindings(`UPDATE "company_secret_bindings" SET "updated_at" = now();`),
    ).toEqual([]);
  });

  it("treats WHERE true and WHERE 1=1 as unqualified", () => {
    expect(
      postureFindings(
        `UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false WHERE true;`,
      ),
    ).toHaveLength(1);
    expect(
      postureFindings(
        `UPDATE "company_secret_bindings" SET "allowed_egress" = '{}' WHERE 1 = 1;`,
      ),
    ).toHaveLength(1);
  });

  it("requires the rule to be named: the `all` wildcard does not silence it", () => {
    const sql = `
      -- paperclip:migration-safety-ignore all: perf reviewed, four-row table
      UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false;
    `;
    expect(postureFindings(sql)).toHaveLength(1);
  });

  it("honors a per-statement opt-out that names the rule and gives a reason", () => {
    const sql = `
      -- paperclip:migration-safety-ignore unqualified-mutation-security-posture-column: one-time arming backfill, reviewed and approved
      UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = true;
    `;
    expect(postureFindings(sql)).toEqual([]);
  });

  it("flags an unqualified DELETE and TRUNCATE against a posture table", () => {
    expect(postureFindings(`DELETE FROM "company_secret_bindings";`)).toHaveLength(1);
    expect(postureFindings(`TRUNCATE TABLE "company_secret_bindings" CASCADE;`)).toHaveLength(1);
    expect(postureFindings(`TRUNCATE ONLY public."company_secret_bindings" RESTART IDENTITY;`))
      .toHaveLength(1);
    expect(postureFindings(`TRUNCATE "companies", "company_secret_bindings";`)).toHaveLength(1);
    expect(
      postureFindings(
        `DELETE FROM "company_secret_bindings" WHERE "id" = '00000000-0000-0000-0000-000000000000';`,
      ),
    ).toEqual([]);
  });

  it("reports every registered posture column a DELETE takes with the row", () => {
    const [finding] = postureFindings(`DELETE FROM "company_secret_bindings";`);
    for (const entry of SECURITY_POSTURE_COLUMNS) {
      expect(finding?.message).toContain(entry.column);
    }
  });
});

// A lint gate is only as good as the statement shapes its
// parser reaches: an unparsed line means no rule runs, and the resulting green
// check is false evidence. Every shape below is asserted in both directions —
// unqualified must fire, selective must stay silent — so a parser regression
// that stops reaching a shape fails the first half rather than passing silently.
describe("unqualified-mutation-security-posture-column parse-miss probe", () => {
  const unqualified: readonly (readonly [string, string])[] = [
    [
      "UPDATE ... FROM ... whose WHERE only constrains the joined table",
      `UPDATE "company_secret_bindings"
       SET "allowed_egress" = '{}'
       FROM "companies" c
       WHERE c."id" IS NOT NULL;`,
    ],
    [
      "WITH x AS (...) UPDATE ...",
      `WITH stale AS (SELECT "id" FROM "company_secret_bindings" WHERE "created_at" < now())
       UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false;`,
    ],
    [
      "DELETE inside a CTE, with the outer statement carrying the only WHERE",
      `WITH removed AS (DELETE FROM "company_secret_bindings" RETURNING "id")
       SELECT "id" FROM removed WHERE "id" IS NOT NULL;`,
    ],
    [
      "UPDATE inside a DO $$ ... $$ block",
      `DO $$
       BEGIN
         UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false;
       END $$;`,
    ],
    [
      "DO block where a LATER statement is the one carrying a WHERE",
      `DO $$
       BEGIN
         UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false;
         UPDATE "company_secret_bindings" SET "allowed_egress" = '{}'
           WHERE "id" = '00000000-0000-0000-0000-000000000000';
       END $$;`,
    ],
    [
      "bare `;` split inside one --> statement-breakpoint segment",
      `ALTER TABLE "company_secret_bindings" ADD COLUMN IF NOT EXISTS "probe" boolean;--> statement-breakpoint
       UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false;
       UPDATE "company_secret_bindings" SET "allowed_egress" = '{}'
         WHERE "id" = '00000000-0000-0000-0000-000000000000';`,
    ],
    [
      "statement isolated by --> statement-breakpoint",
      `ALTER TABLE "company_secret_bindings" ADD COLUMN IF NOT EXISTS "probe" boolean;--> statement-breakpoint
       UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false;`,
    ],
    [
      "schema-qualified and quoted",
      `UPDATE public."company_secret_bindings" SET "egress_allowlist_enforced" = false;`,
    ],
    [
      "schema-qualified with a non-public schema",
      `UPDATE "app"."company_secret_bindings" SET "egress_allowlist_enforced" = false;`,
    ],
    [
      "fully unquoted and mixed case",
      `UPDATE Public.Company_Secret_Bindings SET Egress_Allowlist_Enforced = FALSE;`,
    ],
    [
      "UPDATE ONLY",
      `UPDATE ONLY "company_secret_bindings" SET "egress_allowlist_enforced" = false;`,
    ],
    [
      "aliased target",
      `UPDATE "company_secret_bindings" AS b SET "egress_allowlist_enforced" = false;`,
    ],
    [
      "multi-column SET (a, b) = (...)",
      `UPDATE "company_secret_bindings"
       SET ("allowed_egress", "egress_allowlist_enforced") = ('{}', false);`,
    ],
    [
      "posture column assigned alongside a non-posture column",
      `UPDATE "company_secret_bindings"
       SET "updated_at" = now(), "egress_allowlist_enforced" = false;`,
    ],
  ];

  for (const [shape, sql] of unqualified) {
    it(`reaches and flags: ${shape}`, () => {
      expect(postureFindings(sql).length).toBeGreaterThan(0);
    });
  }

  const selective: readonly (readonly [string, string])[] = [
    [
      "UPDATE ... FROM ... joined back to the target",
      `UPDATE "company_secret_bindings" b
       SET "allowed_egress" = '{}'
       FROM "companies" c
       WHERE c."id" = b."company_id";`,
    ],
    [
      "WITH x AS (...) UPDATE ... WHERE id IN (x)",
      `WITH stale AS (SELECT "id" FROM "company_secret_bindings" WHERE "created_at" < now())
       UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false
       WHERE "id" IN (SELECT "id" FROM stale);`,
    ],
    [
      "UPDATE inside a DO $$ ... $$ block with its own WHERE",
      `DO $$
       BEGIN
         UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false
           WHERE "company_id" = '00000000-0000-0000-0000-000000000000';
       END $$;`,
    ],
    [
      "sub-select in SET does not leak the sub-select's FROM table",
      `UPDATE "company_secret_bindings"
       SET "allowed_egress" = (SELECT "hosts" FROM "companies" WHERE "id" = "company_id")
       WHERE "id" = '00000000-0000-0000-0000-000000000000';`,
    ],
    [
      "unrelated table with an identically named column",
      `UPDATE "some_other_table" SET "egress_allowlist_enforced" = false;`,
    ],
  ];

  for (const [shape, sql] of selective) {
    it(`reaches and clears: ${shape}`, () => {
      expect(postureFindings(sql)).toEqual([]);
    });
  }
});

describe("security-posture registry resolves against the schema", () => {
  // Fixtures are real drizzle tables, not hand-built name maps, so the test also
  // exercises the database-name extraction. A fixture keyed on `egressAllowlistEnforced`
  // rather than on `egress_allowlist_enforced` would pass a hand-built map and
  // still miss every rename in real SQL.
  const baseColumns = {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    allowedEgress: text("allowed_egress").notNull(),
  };

  const enforcedEntry = SECURITY_POSTURE_COLUMNS.find(
    (entry) => entry.column === "egress_allowlist_enforced",
  );

  it("registers egress_allowlist_enforced, which the drift fixtures below rename away", () => {
    expect(enforcedEntry).toBeDefined();
  });

  it("passes against the live schema", () => {
    expect(() => assertSecurityPostureColumnsResolve()).not.toThrow();
  });

  it("fails when a registered column is renamed, naming the pair", () => {
    const renamed = {
      companySecretBindings: pgTable("company_secret_bindings", {
        ...baseColumns,
        egressAllowlistEnforcedV2: boolean("egress_allowlist_enforced_v2").notNull(),
      }),
    };

    expect(() => assertSecurityPostureColumnsResolve(renamed)).toThrow(
      /company_secret_bindings\.egress_allowlist_enforced/,
    );
    // The rename is the innocent-looking case, so the message has to point at it
    // and show the name that replaced it.
    expect(() => assertSecurityPostureColumnsResolve(renamed)).toThrow(
      /renamed\?.*egress_allowlist_enforced_v2/,
    );
  });

  it("fails when a registered column is dropped, naming the pair", () => {
    const dropped = { companySecretBindings: pgTable("company_secret_bindings", baseColumns) };

    expect(() => assertSecurityPostureColumnsResolve(dropped)).toThrow(
      /company_secret_bindings\.egress_allowlist_enforced/,
    );
  });

  it("fails when the registered table itself is renamed away", () => {
    const moved = {
      companySecretBindings: pgTable("company_secret_bindings_v2", {
        ...baseColumns,
        egressAllowlistEnforced: boolean("egress_allowlist_enforced").notNull(),
      }),
    };

    expect(() => assertSecurityPostureColumnsResolve(moved)).toThrow(
      /company_secret_bindings\.egress_allowlist_enforced .*is not in the schema/,
    );
  });

  it("fails closed rather than passing vacuously when no table is reachable", () => {
    expect(() => assertSecurityPostureColumnsResolve({})).toThrow(/no drizzle tables were found/);
  });

  it("fails closed rather than passing vacuously when the registry itself is empty", () => {
    // The registry-side twin of the case above. Emptying the registry — a merge
    // conflict resolved the wrong way, say — degrades the rule to zero coverage in
    // a single edit, and there is no surviving entry for the per-entry loop to
    // report, so without this it reads as a clean pass.
    expect(() => assertSecurityPostureColumnsResolve(undefined, [])).toThrow(/registry is empty/);
  });

  it("rejects an emptied registry from the same entry point the migration lint step runs", async () => {
    // Otherwise the CLI prints "Migration safety check passed" and exits 0 while
    // the rule covers nothing.
    await expect(runMigrationSafetyCheck([])).rejects.toThrow(/registry is empty/);
  });

  it("resolves case-insensitively, matching how the rule folds SQL identifiers", () => {
    const shouting: readonly SecurityPostureColumn[] = [
      {
        table: "COMPANY_SECRET_BINDINGS",
        column: "EGRESS_ALLOWLIST_ENFORCED",
        reason: "unquoted SQL identifiers fold to lowercase",
      },
    ];

    expect(() => assertSecurityPostureColumnsResolve(undefined, shouting)).not.toThrow();
  });

  it("rejects drift from the same entry point the migration lint step runs", async () => {
    const drifted: readonly SecurityPostureColumn[] = [
      {
        table: "company_secret_bindings",
        column: "egress_allowlist_enforced_v2",
        reason: "stale entry left behind by a rename",
      },
    ];

    await expect(runMigrationSafetyCheck(drifted)).rejects.toThrow(
      /company_secret_bindings\.egress_allowlist_enforced_v2/,
    );
    await expect(runMigrationSafetyCheck()).resolves.toMatch(/Migration safety check passed/);
  });
});
