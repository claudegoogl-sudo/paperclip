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
    id: "7b32e0d28820baba",
    rule: "unqualified-mutation-security-posture-column",
    migration: "0233_secret_binding_egress_allowlist.sql",
    table: "company_secret_bindings",
    reason:
      "Fork 0138 renumbered to 0223-0240 block: sets the default-on enforcement flag to false only when the column did not previously exist (guarded by column_existed), so live rows keep their applied state.",
  },
  {
    // id recomputed for the 2026.831.1 sync: the fork-migration renumber
    // 0138_* -> 0233_* and the guarded DO-block rollout text both feed
    // findingId (rule + migration filename + table + normalized statement).
    id: "8d8eaa2bca851a5f",
    rule: "unqualified-mutation-security-posture-column",
    migration: "0233_secret_binding_egress_allowlist.sql",
    table: "company_secret_bindings",
    reason:
      "Rollout UPDATE for the EG4 egress-enforcement flag, wrapped in a DO block gated on whether this run created the column, so re-application is a no-op and live rows keep their applied state. The UPDATE is still textually unqualified, so the rule fires by design — it recognises a selective WHERE, not an arbitrary PL/pgSQL guard, because a guard that is subtly wrong is invisible to a static check. This guard was reviewed on those terms. Baselined for this migration only — any NEW unqualified write to a posture column must fail CI.",
  },
] as const satisfies readonly MigrationSafetyBaselineEntry[];
