import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMigrationOrder } from '../check-pr-migration-order.mjs';

const migration = (name) => `packages/db/src/migrations/${name}.sql`;

test('passes when a PR has no new migrations', () => {
  const result = checkMigrationOrder([migration('0230_on_master')], []);

  assert.equal(result.passed, true);
});

test('passes when every PR migration follows the target branch', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0231_first_in_pr'), migration('0232_second_in_pr')],
  );

  assert.equal(result.passed, true);
});

test('fails with renumbering guidance when a PR reuses the target branch number', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0230_from_stale_branch')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /already contains migrations through .*0230_on_master\.sql/);
  assert.match(result.message, /renumber this PR's migrations starting at 0231/);
  assert.match(result.message, /meta\/_journal\.json/);
});

test('fails when a PR inserts a migration before the target branch tip', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0229_from_stale_branch'), migration('0231_valid_but_after_stale')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /0229_from_stale_branch\.sql/);
  assert.doesNotMatch(result.message, /- packages\/db\/src\/migrations\/0231_valid_but_after_stale\.sql/);
});

test('sync head passes when upstream migrations interleave and the fork block is renumbered losslessly', () => {
  const result = checkMigrationOrder(
    [
      migration('0223_activity_log_run_id_set_null'),
      migration('0240_task_bridge_auto_renew'),
      migration('0241_board_api_key_auth_events'),
    ],
    [
      migration('0223_robust_zaladane'),
      migration('0230_better_auth_account_issuer'),
      migration('0231_activity_log_run_id_set_null'),
      migration('0248_task_bridge_auto_renew'),
      migration('0249_board_api_key_auth_events'),
    ],
    {
      syncHead: true,
      deletedBaseFiles: [
        migration('0223_activity_log_run_id_set_null'),
        migration('0240_task_bridge_auto_renew'),
        migration('0241_board_api_key_auth_events'),
      ],
    },
  );

  assert.equal(result.passed, true);
  assert.match(result.message, /none lost/);
});

test('sync head fails when a renumbered base migration loses its slug', () => {
  const result = checkMigrationOrder(
    [migration('0240_task_bridge_auto_renew')],
    [migration('0223_robust_zaladane')],
    {
      syncHead: true,
      deletedBaseFiles: [migration('0240_task_bridge_auto_renew')],
    },
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /lost base migrations/);
  assert.match(result.message, /0240_task_bridge_auto_renew\.sql/);
});

test('non-sync head keeps the append-only rule even when slugs survive', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0230_on_master')],
    { syncHead: false, deletedBaseFiles: [migration('0230_on_master')] },
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /already contains migrations through/);
});
