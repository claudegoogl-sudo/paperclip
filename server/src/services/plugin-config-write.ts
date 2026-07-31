/**
 * The admin config write path for `POST /api/plugins/:pluginId/config`.
 *
 * Context this exists to fix: since upstream v2026.722.0 made `plugin_config`
 * company-scoped, a plugin can own more than one row (one per company). The
 * no-dispatch `config.get` agreement gate
 * (`plugin-host-services.ts` `getAgreedOrDeny`) resolves a construction-time
 * read only when EVERY owning row agrees on the non-secret-ref portion of
 * `config_json`. The admin write path writes exactly one row at a time, so an
 * ordinary single-company edit silently breaks that agreement for every
 * other company — and `getAgreedOrDeny` starts denying reads it used to
 * resolve (for `paperclip-messenger`, that read backs the live inbound
 * operator Telegram poll loop).
 *
 * This module adds three write-time behaviours, chosen by the request body:
 *
 *  - Default: refuse (409) a write that would break an agreement that
 *    currently holds. Never invents an invariant that isn't already there —
 *    if the owning rows already disagree, the write passes straight through.
 *  - `applyToAllCompanies: true`: fan the non-secret-ref portion of the
 *    write out to every owning row, atomically, while leaving each row's own
 *    secret-ref field values untouched. The caller's own secret-ref values
 *    apply only to their own (`companyId`) row.
 *  - `allowDivergence: true`: today's exact behaviour — write the one row,
 *    no guard.
 *
 * Every branch reuses the same comparator (`structurallyEqual`,
 * `json-schema-secret-refs.ts`) the read-side gate uses, and the same
 * secret-ref validator (`validatePluginSecretRefsForCompany`,
 * `plugin-secrets-handler.ts`) the write path already used previously —
 * this module changes ordering and fan-out, not what "agrees" or "a secret
 * this company may reference" mean.
 */
import type { Db } from "@paperclipai/db";
import type { UpsertPluginConfig } from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { secretService } from "./secrets.js";
import {
  extractSecretRefBindingsFromConfig,
  validatePluginSecretRefsForCompany,
} from "./plugin-secrets-handler.js";
import {
  collectSecretRefPaths,
  computeDivergingTopLevelKeys,
  restoreSecretRefPaths,
  stripSecretRefPaths,
  structurallyEqual,
} from "./json-schema-secret-refs.js";

export class ConfigAgreementGuardError extends Error {
  readonly divergingKeys: string[];

  constructor(divergingKeys: string[]) {
    super(
      `This write would break agreement across owning companies on: ${divergingKeys.join(", ")}. ` +
        `Either resubmit with "applyToAllCompanies": true to apply the non-secret change to every ` +
        `owning company, or with "allowDivergence": true to write only this company's row.`,
    );
    this.name = "ConfigAgreementGuardError";
    this.divergingKeys = divergingKeys;
  }
}

export interface WritePluginConfigOptions {
  applyToAllCompanies?: boolean;
  allowDivergence?: boolean;
}

export interface WritePluginConfigResult {
  row: NonNullable<Awaited<ReturnType<ReturnType<typeof pluginRegistryService>["upsertConfig"]>>>;
  /** Every company id actually written, target company first. */
  companiesWritten: string[];
  fannedOut: boolean;
}

/**
 * Pure evaluator for the write-time guard. Given the rows that own a
 * plugin's config TODAY (before this write) and the config the caller wants
 * to write for `targetCompanyId`, decide whether that write would break an
 * agreement that currently holds.
 *
 * Deliberately narrow: fires only when (a) 2+ owning rows exist, (b) those
 * rows currently agree on the non-secret-ref portion, and (c) the proposed
 * write disagrees with that agreed value. Never fires to invent an
 * invariant — rows that already disagree are already-lost agreement, and
 * this function passes those straight through.
 */
export function evaluateConfigWriteAgreementGuard(
  rows: Array<{ companyId: string; configJson: unknown }>,
  targetCompanyId: string,
  newConfigJson: Record<string, unknown>,
  secretRefPaths: Set<string>,
): { wouldBreakAgreement: boolean; divergingKeys: string[] } {
  if (rows.length <= 1) return { wouldBreakAgreement: false, divergingKeys: [] };

  const stripped = rows.map((row) => ({
    companyId: row.companyId,
    config: stripSecretRefPaths((row.configJson as Record<string, unknown>) ?? {}, secretRefPaths),
  }));
  const [first, ...rest] = stripped;
  const currentlyAgree = rest.every((entry) => structurallyEqual(entry.config, first!.config));
  if (!currentlyAgree) return { wouldBreakAgreement: false, divergingKeys: [] };

  const newTargetStripped = stripSecretRefPaths(newConfigJson, secretRefPaths);
  // Any row agrees with any other today, so any one of them (preferring a
  // row that isn't the one being overwritten) is a valid reference value.
  const reference = stripped.find((entry) => entry.companyId !== targetCompanyId) ?? first!;
  if (structurallyEqual(newTargetStripped, reference.config)) {
    return { wouldBreakAgreement: false, divergingKeys: [] };
  }

  return {
    wouldBreakAgreement: true,
    divergingKeys: computeDivergingTopLevelKeys([newTargetStripped, reference.config]),
  };
}

/**
 * Write `configJson` for `companyId`, applying the agreement guard/fan-out
 * behaviour described above. Runs entirely inside one DB transaction: the
 * guard read, the target row write, and (for `applyToAllCompanies`) every
 * other row's write all commit together or not at all.
 */
export async function writePluginConfigWithAgreement(
  db: Db,
  params: {
    pluginId: string;
    companyId: string;
    configJson: Record<string, unknown>;
    schema: Record<string, unknown> | null | undefined;
    options: WritePluginConfigOptions;
  },
): Promise<WritePluginConfigResult> {
  const { applyToAllCompanies = false, allowDivergence = false } = params.options;
  if (applyToAllCompanies && allowDivergence) {
    throw badRequest('"applyToAllCompanies" and "allowDivergence" are mutually exclusive');
  }

  const secretRefPaths = collectSecretRefPaths(params.schema ?? null);

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const registry = pluginRegistryService(txDb);
    // SELECT ... FOR UPDATE — without this, two concurrent admin
    // writes to the same plugin's config each read at READ COMMITTED with
    // no lock, so both can decide guard/fan-out off the same stale
    // "currently agree" snapshot and both proceed, reintroducing the exact
    // divergence this guard exists to prevent. Locking here serializes
    // concurrent writers on this read; the second writer's read (and every
    // decision downstream of it) only happens after the first commits.
    const rows = await registry.listConfigRows(params.pluginId, { forUpdate: true });

    // applyToAllCompanies is the caller declaring intent to change (or
    // reconcile) the agreed value across every owning row, so the guard —
    // which exists only to catch an *accidental* single-row write breaking
    // an agreement the caller didn't mean to touch — does not apply here.
    if (!allowDivergence && !applyToAllCompanies) {
      const guard = evaluateConfigWriteAgreementGuard(
        rows,
        params.companyId,
        params.configJson,
        secretRefPaths,
      );
      if (guard.wouldBreakAgreement) {
        throw new ConfigAgreementGuardError(guard.divergingKeys);
      }
    }

    // Target row: identical to the prior single-row write — validate
    // and sync secret-ref bindings, then upsert. Scoped to `tx` so it rolls
    // back together with the fan-out below on any failure.
    const secretRefs = extractSecretRefBindingsFromConfig(params.configJson, params.schema);

    // applyToAllCompanies only: skip validate+sync for a secret-ref value
    // that is UNCHANGED from what this row already had. Without this, an
    // unrelated non-secret edit on the post-migration, pre-scrub shape (every
    // company's row still pointing at one company's secret) would 422 on a
    // field this write never touched — strictly worse than the problem this
    // guard exists to fix. Genuinely new/changed refs are still fully
    // validated below. The default guard path and allowDivergence keep the
    // prior write behaviour exactly (AC6): they always validate the full
    // current ref set, matching today's single-row write.
    let refsToValidateAndSync = secretRefs;
    let syncReplaceAll = true;
    if (applyToAllCompanies) {
      const existingTargetRow = rows.find((r) => r.companyId === params.companyId);
      const oldRefsByPath = new Map(
        extractSecretRefBindingsFromConfig(
          (existingTargetRow?.configJson as Record<string, unknown>) ?? null,
          params.schema,
        ).map((ref) => [ref.configPath, ref.secretId]),
      );
      refsToValidateAndSync = secretRefs.filter(
        (ref) => oldRefsByPath.get(ref.configPath) !== ref.secretId,
      );
      syncReplaceAll = false;
    }
    if (refsToValidateAndSync.length > 0 || syncReplaceAll) {
      await validatePluginSecretRefsForCompany(txDb, params.companyId, refsToValidateAndSync);
      await secretService(txDb).syncSecretRefsForTarget(
        params.companyId,
        { targetType: "plugin", targetId: params.pluginId },
        refsToValidateAndSync,
        // exactPathDelete only matters when syncReplaceAll is
        // false (the applyToAllCompanies fan-out passing a CHANGED-only
        // ref subset) — see syncSecretRefsForTarget's doc comment. It is a
        // no-op when syncReplaceAll is true (the replaceAll branch wins).
        { replaceAll: syncReplaceAll, exactPathDelete: true },
      );
    }
    const targetInput: UpsertPluginConfig = {
      companyId: params.companyId,
      configJson: params.configJson,
    };
    const row = await registry.upsertConfig(params.pluginId, params.companyId, targetInput);

    const companiesWritten = [params.companyId];

    if (applyToAllCompanies) {
      const nonSecretConfig = stripSecretRefPaths(params.configJson, secretRefPaths);
      for (const existingRow of rows) {
        if (existingRow.companyId === params.companyId) continue;
        const finalConfig = restoreSecretRefPaths(
          nonSecretConfig,
          (existingRow.configJson as Record<string, unknown>) ?? {},
          secretRefPaths,
        );
        await registry.setConfigJsonForExistingRow(params.pluginId, existingRow.companyId, finalConfig);
        companiesWritten.push(existingRow.companyId);
      }
    }

    return { row: row!, companiesWritten, fannedOut: applyToAllCompanies };
  });
}
