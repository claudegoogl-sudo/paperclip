export type MigrationSafetyBaselineEntry = {
  readonly id: string;
  readonly rule: string;
  readonly migration: string;
  readonly table: string;
  readonly reason: string;
};

export const MIGRATION_SAFETY_BASELINE = [
  {
    id: "2cfa16c89e561306",
    rule: "large-create-index-not-concurrently",
    migration: "0000_mature_masked_marvel.sql",
    table: "activity_log",
    reason: "Initial schema history predates the migration-safety guard.",
  },
  {
    id: "2e21c87a27d0ecf3",
    rule: "large-create-index-not-concurrently",
    migration: "0000_mature_masked_marvel.sql",
    table: "issue_comments",
    reason: "Initial schema history predates the migration-safety guard.",
  },
  {
    id: "3fa7b338f437c89d",
    rule: "large-create-index-not-concurrently",
    migration: "0000_mature_masked_marvel.sql",
    table: "issue_comments",
    reason: "Initial schema history predates the migration-safety guard.",
  },
  {
    id: "26bf13d0e36e3bd0",
    rule: "large-create-index-not-concurrently",
    migration: "0001_fast_northstar.sql",
    table: "agent_wakeup_requests",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "da73c844de91f262",
    rule: "large-create-index-not-concurrently",
    migration: "0001_fast_northstar.sql",
    table: "agent_wakeup_requests",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "b86e70ea500d5d9e",
    rule: "large-create-index-not-concurrently",
    migration: "0001_fast_northstar.sql",
    table: "agent_wakeup_requests",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "d12aeab5a11d37fe",
    rule: "large-create-index-not-concurrently",
    migration: "0001_fast_northstar.sql",
    table: "heartbeat_run_events",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "80d2cc53747b47bc",
    rule: "large-create-index-not-concurrently",
    migration: "0001_fast_northstar.sql",
    table: "heartbeat_run_events",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "8985fd1ec26c0449",
    rule: "large-create-index-not-concurrently",
    migration: "0001_fast_northstar.sql",
    table: "heartbeat_run_events",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "06065c3f2e8bca76",
    rule: "large-create-index-not-concurrently",
    migration: "0003_shallow_quentin_quire.sql",
    table: "activity_log",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "d0cb536e5b329013",
    rule: "large-create-index-not-concurrently",
    migration: "0003_shallow_quentin_quire.sql",
    table: "activity_log",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "b84802ae05be9943",
    rule: "large-create-index-not-concurrently",
    migration: "0024_far_beast.sql",
    table: "issue_comments",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "3eaba6ddfa29a678",
    rule: "large-create-index-not-concurrently",
    migration: "0024_far_beast.sql",
    table: "issue_comments",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "2874b94c3f294f53",
    rule: "large-create-index-not-concurrently",
    migration: "0051_young_korg.sql",
    table: "issue_comments",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "f0a44a3401b28d62",
    rule: "large-create-index-not-concurrently",
    migration: "0060_orange_annihilus.sql",
    table: "issue_reference_mentions",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "f1fbb786a033df8d",
    rule: "large-create-index-not-concurrently",
    migration: "0060_orange_annihilus.sql",
    table: "issue_reference_mentions",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "f74aa7dfb0152788",
    rule: "large-create-index-not-concurrently",
    migration: "0060_orange_annihilus.sql",
    table: "issue_reference_mentions",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "3c1237481d6ee00d",
    rule: "large-create-index-not-concurrently",
    migration: "0060_orange_annihilus.sql",
    table: "issue_reference_mentions",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "21cf0a7bb66a4058",
    rule: "large-create-index-not-concurrently",
    migration: "0060_orange_annihilus.sql",
    table: "issue_reference_mentions",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "567b97176f9f06c3",
    rule: "large-create-index-not-concurrently",
    migration: "0132_issue_comment_derived_attribution_fast.sql",
    table: "issue_comments",
    reason: "Existing issue-attribution backfill branch uses a temporary support index before this guard landed.",
  },
  {
    id: "38d8055cc228913d",
    rule: "full-table-mutation-large-table",
    migration: "0132_issue_comment_derived_attribution_fast.sql",
    table: "issue_comments",
    reason: "Batched DO-loop backfill with keyset pagination (LIMIT 5000 per batch); reviewed and approved as part of PAP-1505 fix. Already merged to master before this guard landed.",
  },
  {
    id: "9101cdb1c8bec88c",
    rule: "unqualified-mutation-security-posture-column",
    migration: "0173_inbox_policy_agent_cleanup.sql",
    table: "user_inbox_agent_policies",
    reason:
      "Upstream 817 cleanup trigger: on agent deletion it removes exactly that agent's id from allowlist rows (WHERE matches the deleted id), so the mutation is row-scoped by construction.",
  },
  {
    id: "eaf4a8b69debecc9",
    rule: "unqualified-mutation-security-posture-column",
    migration: "0182_connections_v3_schema_core.sql",
    table: "tool_connections",
    reason:
      "Upstream one-time backfill executed in the same migration that introduces the column: auth_kind is derived from the connection's own config/credential refs, not from any external input.",
  },
  {
    // id recomputed for the 2026.916.0 sync: the fork-migration renumber
    // 0233_* -> 0282_* feeds findingId (rule + migration filename + table +
    // normalized statement). Prior ids: 7b32e0d28820baba (0138_* name),
    // 8d8eaa2bca851a5f (0233_* name).
    id: "13833088093ef6c5",
    rule: "unqualified-mutation-security-posture-column",
    migration: "0282_secret_binding_egress_allowlist.sql",
    table: "company_secret_bindings",
    reason:
      "Rollout UPDATE for the EG4 egress-enforcement flag, wrapped in a DO block gated on whether this run created the column, so re-application is a no-op and live rows keep their applied state (fork 0138, renumbered 0233 then 0282). The UPDATE is still textually unqualified, so the rule fires by design — it recognises a selective WHERE, not an arbitrary PL/pgSQL guard, because a guard that is subtly wrong is invisible to a static check. This guard was reviewed on those terms. Baselined for this migration only — any NEW unqualified write to a posture column must fail CI.",
  },
  {
    // Upstream v2026.916.0 migration, baselined during the 916.0 sync merge:
    // registering adapter_auth_sessions.connection_id/connection_grant_id as
    // posture columns (they are the resolved session->connection binding
    // local-ai-login returns) made upstream's row-clearing DELETE a finding.
    id: "4bad7538284b878c",
    rule: "unqualified-mutation-security-posture-column",
    migration: "0224_unified_adapter_auth_sessions.sql",
    table: "adapter_auth_sessions",
    reason:
      "Upstream's deliberate deploy-window decision, documented in the migration's own header: adapter_auth_sessions rows are short-lived login sessions, and rather than backfilling the new NOT NULL public_session_id the migration deletes existing rows so a dropped login session re-starts. No persisted authorization state is downgraded — the table only ever held in-flight logins — and the delete ships in the same migration that reshapes the table, so it cannot run twice.",
  },
] as const satisfies readonly MigrationSafetyBaselineEntry[];
