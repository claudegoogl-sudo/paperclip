#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIRECTORY = 'packages/db/src/migrations/';
const MIGRATION_FILE_PATTERN = /^packages\/db\/src\/migrations\/(\d{4})_[^/]+\.sql$/;

function parseMigration(file) {
  const match = file.match(MIGRATION_FILE_PATTERN);
  return match ? { file, number: Number.parseInt(match[1], 10) } : null;
}

function formatMigrationNumber(number) {
  return String(number).padStart(4, '0');
}

function migrationSlug(file) {
  return file.split('/').pop().replace(/^\d{4}_/, '');
}

export function checkMigrationOrder(baseMigrationFiles, prMigrationFiles, opts = {}) {
  const invalidFiles = [...baseMigrationFiles, ...prMigrationFiles]
    .filter((file) => !parseMigration(file));

  if (invalidFiles.length > 0) {
    return {
      passed: false,
      message: [
        'Migration SQL files must start with a 4-digit number:',
        ...invalidFiles.map((file) => `- ${file}`),
      ].join('\n'),
    };
  }

  if (prMigrationFiles.length === 0) {
    return { passed: true, message: 'No new migrations in this PR.' };
  }

  const baseMigrations = baseMigrationFiles.map(parseMigration);
  const prMigrations = prMigrationFiles.map(parseMigration);
  const latestBaseMigration = baseMigrations.reduce(
    (latest, migration) => migration.number > latest.number ? migration : latest,
    { file: '(none)', number: -1 },
  );

  // Fork-local sync patch (upstream PR #12433 has no sync concept). An
  // upstream-sync merge interleaves upstream's new migrations with the
  // fork's own renumbered block, so the append-only numbering rule below
  // can never hold for a sync head. The invariant that matters instead is
  // losslessness: every base migration survives on the head side, where
  // surviving means its slug (filename minus the 4-digit number) appears
  // among the added files after a renumber. Duplicate numbers and journal
  // alignment stay the job of check:migrations.
  const syncHead = opts.syncHead ?? /^sync\/upstream-/.test(process.env.GITHUB_HEAD_REF ?? '');
  if (syncHead) {
    const addedSlugs = new Set(prMigrations.map((migration) => migrationSlug(migration.file)));
    const lost = (opts.deletedBaseFiles ?? [])
      .map(parseMigration)
      .filter((migration) => migration && !addedSlugs.has(migrationSlug(migration.file)));
    if (lost.length > 0) {
      return {
        passed: false,
        message: [
          'Sync merge lost base migrations. A renumbered migration must keep its slug:',
          ...lost.map((migration) => `- ${migration.file}`),
        ].join('\n'),
      };
    }
    const renumbered = (opts.deletedBaseFiles ?? []).length;
    return {
      passed: true,
      message: [
        `Sync merge: upstream migrations interleave with the fork block (base tip ${latestBaseMigration.file}).`,
        `${renumbered} base migration(s) renumbered, none lost.`,
      ].join('\n'),
    };
  }

  const outOfOrder = prMigrations.filter(
    (migration) => migration.number <= latestBaseMigration.number,
  );

  if (outOfOrder.length === 0) {
    return {
      passed: true,
      message: `All new migrations follow ${latestBaseMigration.file}.`,
    };
  }

  const nextNumber = formatMigrationNumber(latestBaseMigration.number + 1);
  return {
    passed: false,
    message: [
      `The target branch already contains migrations through ${latestBaseMigration.file}.`,
      'This PR adds migration numbers that would be inserted into or collide with that history:',
      ...outOfOrder.map((migration) => `- ${migration.file}`),
      '',
      `Update from the target branch, then renumber this PR's migrations starting at ${nextNumber}`,
      'in their intended order. Keep each SQL filename, matching meta snapshot, and',
      'packages/db/src/migrations/meta/_journal.json entry aligned, then push again.',
      'Migration numbers are append-only and cannot reuse a number already present on the target branch.',
    ].join('\n'),
  };
}

function gitPaths(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function escapeWorkflowCommand(message) {
  return message
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

function main() {
  const [baseSha, headSha] = process.argv.slice(2);
  const shaPattern = /^[0-9a-f]{40}$/i;
  if (!shaPattern.test(baseSha ?? '') || !shaPattern.test(headSha ?? '')) {
    console.error('Usage: check-pr-migration-order.mjs <40-character base SHA> <40-character head SHA>');
    process.exit(2);
  }

  const baseMigrationFiles = gitPaths([
    'ls-tree', '-r', '--name-only', '-z', baseSha, '--', MIGRATIONS_DIRECTORY,
  ]).filter((file) => file.endsWith('.sql'));
  const prMigrationFiles = gitPaths([
    'diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', `${baseSha}...${headSha}`, '--',
    MIGRATIONS_DIRECTORY,
  ]).filter((file) => file.endsWith('.sql'));
  const deletedBaseFiles = gitPaths([
    'diff', '--name-only', '--no-renames', '--diff-filter=D', '-z', `${baseSha}...${headSha}`, '--',
    MIGRATIONS_DIRECTORY,
  ]).filter((file) => file.endsWith('.sql'));
  const result = checkMigrationOrder(baseMigrationFiles, prMigrationFiles, { deletedBaseFiles });

  if (result.passed) {
    console.log(result.message);
    return;
  }

  console.error(
    `::error title=Migration numbers must follow the target branch::${escapeWorkflowCommand(result.message)}`,
  );
  console.error(result.message);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
