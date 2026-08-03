import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MIGRATION_SAFETY_BASELINE } from "./migration-safety-baseline.js";
import {
  isSecurityPostureTable,
  matchedPostureColumns,
  postureColumnsForTable,
} from "./security-posture-columns.js";
import {
  getTableSizeEstimate,
  isKnownLargeTable,
  type TableSizeEstimate,
} from "./table-size-estimates.js";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

export type MigrationSafetyRule =
  | "loop-mutation-large-table"
  | "batched-mutation-large-table-missing-index"
  | "full-table-mutation-large-table"
  | "large-create-index-not-concurrently"
  | "unqualified-mutation-security-posture-column";

// Rules that model security risk rather than performance risk. Excluded from the
// `migration-safety-ignore all` wildcard so a perf-motivated blanket ignore
// cannot quietly disarm a security check — silencing these must name the rule.
const SECURITY_RULES = new Set<MigrationSafetyRule>([
  "unqualified-mutation-security-posture-column",
]);

export type MigrationSafetySeverity = "error" | "warning";

export type MigrationSafetyFinding = {
  readonly id: string;
  readonly rule: MigrationSafetyRule;
  readonly severity: MigrationSafetySeverity;
  readonly migration: string;
  readonly table: string;
  readonly statement: string;
  readonly message: string;
};

export type MigrationSafetyInput = {
  readonly fileName: string;
  readonly sql: string;
};

export type MigrationSafetyResult = {
  readonly findings: readonly MigrationSafetyFinding[];
  readonly newFindings: readonly MigrationSafetyFinding[];
  readonly baselineFindings: readonly MigrationSafetyFinding[];
  readonly staleBaselineIds: readonly string[];
};

type RuleMetadata = {
  readonly severity: MigrationSafetySeverity;
  readonly message: string;
};

type CreateIndexInfo = {
  readonly table: string;
  readonly columns: readonly string[];
  readonly predicate: string | null;
  readonly predicateColumns: readonly string[];
  readonly concurrently: boolean;
  readonly statement: string;
};

type MutationKind = "update" | "delete" | "truncate";

type MutationInfo = {
  readonly kind: MutationKind;
  readonly table: string;
  readonly statementSql: string;
  readonly keywordIndex: number;
};

const RULE_METADATA: Record<MigrationSafetyRule, RuleMetadata> = {
  "loop-mutation-large-table": {
    severity: "error",
    message: "DO $$ loop mutates a known-large table without a same-migration support index",
  },
  "batched-mutation-large-table-missing-index": {
    severity: "error",
    message: "Batched LIMIT mutation over a known-large table lacks a same-migration support index",
  },
  "full-table-mutation-large-table": {
    severity: "error",
    message: "Known-large table mutation does not have a selective WHERE clause",
  },
  "large-create-index-not-concurrently": {
    severity: "warning",
    message: "CREATE INDEX on a known-large table is missing CONCURRENTLY",
  },
  "unqualified-mutation-security-posture-column": {
    severity: "error",
    message: "Unqualified mutation of a registered security-posture column",
  },
};

const RESERVED_ALIAS_WORDS = new Set([
  "add",
  "alter",
  "as",
  "delete",
  "from",
  "on",
  "returning",
  "set",
  "using",
  "where",
  "with",
]);

function normalizeIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^"public"\s*\.\s*/i, "")
    .replace(/^public\s*\.\s*/i, "")
    .replace(/^"/, "")
    .replace(/"$/, "")
    .replaceAll('""', '"');
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function statementExcerpt(statement: string): string {
  const normalized = normalizeSql(statement);
  if (normalized.length <= 700) return normalized;
  return `${normalized.slice(0, 700)}...`;
}

function findingId(
  rule: MigrationSafetyRule,
  migration: string,
  table: string,
  statement: string,
): string {
  return createHash("sha256")
    .update(`${rule}\0${migration}\0${table}\0${normalizeSql(statement)}`)
    .digest("hex")
    .slice(0, 16);
}

function splitSqlStatements(sql: string): string[] {
  const breakpointParts = sql
    .split(/-->\s*statement-breakpoint/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (breakpointParts.length > 1) return breakpointParts;

  const statements: string[] = [];
  let start = 0;
  let singleQuoted = false;
  let dollarQuoteTag: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    if (dollarQuoteTag) {
      if (sql.startsWith(dollarQuoteTag, index)) {
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      }
      continue;
    }

    const char = sql[index];
    if (singleQuoted) {
      if (char === "'" && sql[index + 1] === "'") {
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }

    if (char === "'") {
      singleQuoted = true;
      continue;
    }

    if (char === "$") {
      const tag = dollarQuoteTagAt(sql, index);
      if (tag) {
        dollarQuoteTag = tag;
        index += dollarQuoteTag.length - 1;
      }
      continue;
    }

    if (char === ";") {
      const statement = sql.slice(start, index + 1).trim();
      if (statement.length > 0) statements.push(statement);
      start = index + 1;
    }
  }

  const tail = sql.slice(start).trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

function ignoreRules(statement: string): Set<string> {
  const rules = new Set<string>();
  const pattern = /--\s*paperclip:migration-safety-ignore\s+([a-z0-9-]+|all)\s*:\s*(\S.*)$/gim;
  for (const match of statement.matchAll(pattern)) {
    const rule = match[1];
    const reason = match[2]?.trim();
    if (rule && reason) rules.add(rule);
  }
  return rules;
}

function isIgnored(statement: string, rule: MigrationSafetyRule): boolean {
  const ignored = ignoreRules(statement);
  if (ignored.has(rule)) return true;
  return !SECURITY_RULES.has(rule) && ignored.has("all");
}

function skipSingleQuotedLiteral(statement: string, startIndex: number): number {
  let index = startIndex + 1;
  while (index < statement.length) {
    if (statement[index] === "'" && statement[index + 1] === "'") {
      index += 2;
      continue;
    }
    if (statement[index] === "'") return index + 1;
    index += 1;
  }
  return index;
}

function skipDoubleQuotedIdentifier(statement: string, startIndex: number): number {
  let index = startIndex + 1;
  while (index < statement.length) {
    if (statement[index] === '"' && statement[index + 1] === '"') {
      index += 2;
      continue;
    }
    if (statement[index] === '"') return index + 1;
    index += 1;
  }
  return index;
}

function skipLineComment(statement: string, startIndex: number): number {
  const newlineIndex = statement.indexOf("\n", startIndex + 2);
  return newlineIndex === -1 ? statement.length : newlineIndex;
}

function skipBlockComment(statement: string, startIndex: number): number {
  let depth = 1;
  let index = startIndex + 2;
  while (index < statement.length && depth > 0) {
    if (statement.startsWith("/*", index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (statement.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
      continue;
    }
    index += 1;
  }
  return index;
}

function skipDollarQuotedString(statement: string, startIndex: number): number {
  const tag = dollarQuoteTagAt(statement, startIndex);
  if (!tag) return startIndex;
  const closeIndex = statement.indexOf(tag, startIndex + tag.length);
  return closeIndex === -1 ? statement.length : closeIndex + tag.length;
}

function stripSqlComments(statement: string): string {
  let stripped = "";
  let index = 0;

  while (index < statement.length) {
    const char = statement[index];
    const next = statement[index + 1];

    if (char === "'") {
      const literalEnd = skipSingleQuotedLiteral(statement, index);
      stripped += statement.slice(index, literalEnd);
      index = literalEnd;
      continue;
    }

    if (char === '"') {
      const identifierEnd = skipDoubleQuotedIdentifier(statement, index);
      stripped += statement.slice(index, identifierEnd);
      index = identifierEnd;
      continue;
    }

    if (char === "$") {
      const dollarEnd = skipDollarQuotedString(statement, index);
      if (dollarEnd !== index) {
        stripped += statement.slice(index, dollarEnd);
        index = dollarEnd;
        continue;
      }
    }

    if (char === "-" && next === "-") {
      stripped += " ";
      index = skipLineComment(statement, index);
      continue;
    }

    if (char === "/" && next === "*") {
      stripped += " ";
      const commentEnd = skipBlockComment(statement, index);
      for (let commentIndex = index; commentIndex < commentEnd; commentIndex += 1) {
        if (statement[commentIndex] === "\n") stripped += "\n";
      }
      index = commentEnd;
      continue;
    }

    stripped += char;
    index += 1;
  }

  return stripped;
}

function skipSqlTrivia(statement: string, index: number): number {
  const char = statement[index];
  const next = statement[index + 1];
  if (char === "'") return skipSingleQuotedLiteral(statement, index);
  if (char === '"') return skipDoubleQuotedIdentifier(statement, index);
  if (char === "$") {
    const end = skipDollarQuotedString(statement, index);
    if (end !== index) return end;
  }
  if (char === "-" && next === "-") return skipLineComment(statement, index);
  if (char === "/" && next === "*") return skipBlockComment(statement, index);
  return index;
}

function identifierList(value: string): string[] {
  return [...value.matchAll(/"([^"]+)"|(?:^|[\s,(])([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((match) => normalizeIdentifier(match[1] ?? match[2] ?? ""))
    .filter((identifier) => identifier.length > 0)
    .filter((identifier) => !RESERVED_ALIAS_WORDS.has(identifier.toLowerCase()));
}

function plainIndexColumns(columnSpec: string): string[] {
  // Only include simple column references. Skip expression columns such as
  // (id * 2) or lower(col) — PostgreSQL cannot use those to satisfy ORDER BY
  // on the plain column, so they must not suppress a missing-index finding.
  return splitSqlList(columnSpec).flatMap((part) => {
    const trimmed = part.trim();
    if (/\(/.test(trimmed)) return [];
    return identifierList(trimmed);
  });
}

function splitSqlList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (singleQuoted) {
      if (char === "'" && value[index + 1] === "'") {
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }

    if (doubleQuoted) {
      if (char === '"' && value[index + 1] === '"') {
        index += 1;
      } else if (char === '"') {
        doubleQuoted = false;
      }
      continue;
    }

    if (char === "'") {
      singleQuoted = true;
      continue;
    }

    if (char === '"') {
      doubleQuoted = true;
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === "," && depth === 0) {
      const part = value.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }

  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function orderByExpressionColumn(value: string): string | null {
  const withoutSortModifiers = value
    .replace(/\bCOLLATE\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/gi, " ")
    .replace(/\bNULLS\s+(?:FIRST|LAST)\b/gi, " ")
    .replace(/\b(?:ASC|DESC)\b/gi, " ");
  const identifiers = [
    ...withoutSortModifiers.matchAll(/"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)/g),
  ]
    .map((match) => normalizeIdentifier(match[1] ?? match[2] ?? ""))
    .filter((identifier) => identifier.length > 0)
    .filter((identifier) => !RESERVED_ALIAS_WORDS.has(identifier.toLowerCase()));
  return identifiers[identifiers.length - 1] ?? null;
}

function predicateColumns(statement: string): string[] {
  const columns = new Set<string>();
  const sql = stripSqlComments(statement);
  const predicatePattern = /\b(?:WHERE|ORDER\s+BY|ON)\b([\s\S]*?)(?=\b(?:LIMIT|RETURNING|GROUP\s+BY|ORDER\s+BY|SET|FROM)\b|$)/gi;
  for (const match of sql.matchAll(predicatePattern)) {
    for (const identifier of identifierList(match[1] ?? "")) {
      columns.add(identifier);
    }
  }
  return [...columns];
}

type KeywordOccurrence = {
  readonly index: number;
  readonly depth: number;
  readonly length: number;
};

function keywordOccurrenceAt(
  sql: string,
  index: number,
  pattern: RegExp,
): RegExpMatchArray | null {
  const previous = sql[index - 1];
  if (previous && /[A-Za-z0-9_]/.test(previous)) return null;
  return sql.slice(index).match(pattern);
}

function keywordOccurrences(sql: string, pattern: RegExp): KeywordOccurrence[] {
  const occurrences: KeywordOccurrence[] = [];
  let depth = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    if (char === "'") {
      index = skipSingleQuotedLiteral(sql, index);
      continue;
    }

    if (char === '"') {
      index = skipDoubleQuotedIdentifier(sql, index);
      continue;
    }

    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    const match = keywordOccurrenceAt(sql, index, pattern);
    if (match) {
      occurrences.push({ index, depth, length: match[0].length });
      index += match[0].length;
      continue;
    }

    index += 1;
  }

  return occurrences;
}

function batchWhereClausesBeforeOrderBy(statement: string): string[] {
  const sql = stripSqlComments(statement);
  const whereOccurrences = keywordOccurrences(sql, /^\bWHERE\b/i);
  const orderByOccurrences = keywordOccurrences(sql, /^\bORDER\s+BY\b/i);
  const clauses: string[] = [];

  for (const orderBy of orderByOccurrences) {
    const where = whereOccurrences
      .filter((candidate) => candidate.depth === orderBy.depth && candidate.index < orderBy.index)
      .at(-1);
    if (!where) continue;

    const clause = sql.slice(where.index + where.length, orderBy.index).trim();
    if (clause) clauses.push(clause);
  }

  return clauses;
}

function hasBalancedOuterParens(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'") {
      index = skipSingleQuotedLiteral(value, index) - 1;
      continue;
    }
    if (char === '"') {
      index = skipDoubleQuotedIdentifier(value, index) - 1;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }

  return depth === 0;
}

function stripOuterParens(value: string): string {
  let stripped = normalizeSql(value).replace(/;$/, "").trim();
  while (hasBalancedOuterParens(stripped)) {
    stripped = normalizeSql(stripped.slice(1, -1));
  }
  return stripped;
}

function splitConjunctivePredicate(value: string): string[] {
  const terms: string[] = [];
  const sql = stripOuterParens(value);
  let depth = 0;
  let start = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    if (char === "'") {
      index = skipSingleQuotedLiteral(sql, index);
      continue;
    }

    if (char === '"') {
      index = skipDoubleQuotedIdentifier(sql, index);
      continue;
    }

    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    const match = depth === 0 ? keywordOccurrenceAt(sql, index, /^\bAND\b/i) : null;
    if (match) {
      const term = stripOuterParens(sql.slice(start, index));
      if (term) terms.push(term);
      start = index + match[0].length;
      index = start;
      continue;
    }

    index += 1;
  }

  const tail = stripOuterParens(sql.slice(start));
  if (tail) terms.push(tail);
  return terms;
}

function lowercaseSqlOutsideSingleQuotedLiterals(value: string): string {
  let lowered = "";
  let index = 0;

  while (index < value.length) {
    if (value[index] === "'") {
      const end = skipSingleQuotedLiteral(value, index);
      lowered += value.slice(index, end);
      index = end;
      continue;
    }

    lowered += value[index]?.toLowerCase() ?? "";
    index += 1;
  }

  return lowered;
}

function normalizePredicateTerm(term: string): string {
  const normalized = stripOuterParens(term)
    .replace(
      /(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/g,
      "$1",
    )
    .replace(/"([^"]+)"/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return lowercaseSqlOutsideSingleQuotedLiterals(normalized);
}

function predicateTerms(value: string): Set<string> {
  return new Set(splitConjunctivePredicate(value).map(normalizePredicateTerm));
}

function orderByColumns(statement: string): string[] {
  const columns: string[] = [];
  const sql = stripSqlComments(statement);
  const pattern = /\bORDER\s+BY\b([\s\S]*?)(?=\b(?:LIMIT|RETURNING|GROUP\s+BY|WHERE|SET|FROM|END|LOOP)\b|$)/gi;
  for (const match of sql.matchAll(pattern)) {
    for (const expression of splitSqlList(match[1] ?? "")) {
      const column = orderByExpressionColumn(expression);
      if (column && !columns.includes(column)) {
        columns.push(column);
      }
    }
  }
  return columns;
}

function parseCreateIndexes(statement: string): CreateIndexInfo[] {
  const indexes: CreateIndexInfo[] = [];
  const sql = stripSqlComments(statement);
  const pattern =
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s+ON\s+(?:(?:"public"|public)\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*(?:USING\s+[A-Za-z_][A-Za-z0-9_]*\s*)?\(([\s\S]*?)\)(?:\s+WHERE\s+([\s\S]*))?/gi;

  for (const match of sql.matchAll(pattern)) {
    const table = normalizeIdentifier(match[2] ?? match[3] ?? "");
    if (!table) continue;
    const predicate = match[5]?.trim().replace(/;$/, "").trim() ?? "";
    indexes.push({
      table,
      columns: plainIndexColumns(match[4] ?? ""),
      predicate: predicate.length > 0 ? predicate : null,
      predicateColumns: predicateColumns(predicate),
      concurrently: Boolean(match[1]),
      statement,
    });
  }

  return indexes;
}

// Any schema qualifier, not just `public.`. A security rule that reads
// `app.company_secret_bindings` as table `app` would fail open.
const SCHEMA_QUALIFIER = String.raw`(?:(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?`;
const TABLE_REFERENCE = String.raw`(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))`;
const OPTIONAL_ALIAS = String.raw`(?:\s+(?:AS\s+)?(?:"?[A-Za-z_][A-Za-z0-9_]*"?))?`;

function parseMutations(statement: string): MutationInfo[] {
  const mutations: MutationInfo[] = [];
  const sql = stripSqlComments(statement);
  const updatePattern = new RegExp(
    String.raw`\bUPDATE\s+(?:ONLY\s+)?${SCHEMA_QUALIFIER}${TABLE_REFERENCE}${OPTIONAL_ALIAS}`,
    "gi",
  );
  const deletePattern = new RegExp(
    String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${SCHEMA_QUALIFIER}${TABLE_REFERENCE}${OPTIONAL_ALIAS}`,
    "gi",
  );

  for (const match of sql.matchAll(updatePattern)) {
    const table = normalizeIdentifier(match[1] ?? match[2] ?? "");
    if (table) {
      mutations.push({ kind: "update", table, statementSql: sql, keywordIndex: match.index ?? 0 });
    }
  }

  for (const match of sql.matchAll(deletePattern)) {
    const table = normalizeIdentifier(match[1] ?? match[2] ?? "");
    if (table) {
      mutations.push({ kind: "delete", table, statementSql: sql, keywordIndex: match.index ?? 0 });
    }
  }

  for (const truncate of parseTruncates(sql)) {
    mutations.push(truncate);
  }

  return mutations;
}

function parseTruncates(sql: string): MutationInfo[] {
  const truncates: MutationInfo[] = [];
  const pattern =
    /\bTRUNCATE\b(?:\s+TABLE\b)?\s+([\s\S]*?)(?=\b(?:RESTART|CONTINUE|CASCADE|RESTRICT)\b|;|$)/gi;
  const tableReference = new RegExp(String.raw`^(?:ONLY\s+)?${SCHEMA_QUALIFIER}${TABLE_REFERENCE}`, "i");

  for (const match of sql.matchAll(pattern)) {
    for (const entry of splitSqlList(match[1] ?? "")) {
      const reference = entry.trim().match(tableReference);
      const table = normalizeIdentifier(reference?.[1] ?? reference?.[2] ?? "");
      if (table) {
        truncates.push({
          kind: "truncate",
          table,
          statementSql: sql,
          keywordIndex: match.index ?? 0,
        });
      }
    }
  }

  return truncates;
}

function hasDoLoop(statement: string): boolean {
  return /\bDO\s+\$[A-Za-z_]*\$[\s\S]*\bLOOP\b/i.test(statement);
}

function hasBatchedLimitMutation(statement: string): boolean {
  const hasLimit = /\bLIMIT\s+(?:\d+|[A-Za-z_][A-Za-z0-9_]*|\$[0-9]+)\b/i.test(statement);
  const hasFetchLimit =
    /\bFETCH\s+(?:FIRST|NEXT)(?:\s+(?:\d+|[A-Za-z_][A-Za-z0-9_]*|\$[0-9]+))?\s+ROWS?\s+(?:ONLY|WITH\s+TIES)\b/i.test(statement);
  const hasDml = /\b(?:UPDATE|DELETE)\b/i.test(statement);
  return (hasLimit || hasFetchLimit) && hasDml;
}

function dollarQuoteTagAt(statement: string, startIndex: number): string | null {
  if (statement[startIndex] !== "$") return null;
  const match = statement.slice(startIndex).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
  return match?.[0] ?? null;
}

function topLevelWhereClause(statement: string, startIndex: number): string | null {
  // Walk character-by-character, tracking paren depth.
  // Only consider WHERE keywords at depth 0 after the target mutation.
  let depth = 0;
  let i = startIndex;
  while (i < statement.length) {
    const nextIndex = skipSqlTrivia(statement, i);
    if (nextIndex !== i) {
      i = nextIndex;
      continue;
    }

    const ch = statement[i];
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0) {
      const rem = statement.slice(i);
      const m = rem.match(/^\bWHERE\b/i);
      if (m) return rem.slice(m[0].length);
    }
    i++;
  }
  return null;
}

function hasSelectiveWhere(mutation: MutationInfo): boolean {
  const afterWhere = topLevelWhereClause(mutation.statementSql, mutation.keywordIndex);
  if (!afterWhere) return false;

  const whereClause = normalizeSql(afterWhere).replace(/;$/, "");
  if (/^(?:true|1\s*=\s*1)$/i.test(whereClause)) return false;
  if (!/(?:=|<>|!=|<|>|\bIN\s*\(|\bEXISTS\s*\(|\bLIKE\b|\bIS\s+(?:NOT\s+)?NULL\b)/i.test(whereClause))
    return false;

  // A WHERE that only constrains joined tables is not a filter on the target table.
  // Collect every table-qualified column reference (both "tbl"."col" and alias."col").
  const qualRefs = [
    ...whereClause.matchAll(/"([^"]+)"\s*\.\s*(?:"[^"]+"|\w+)/g),
    ...whereClause.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\."[^"]+"/g),
    ...whereClause.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g),
  ].map((m) => normalizeIdentifier(m[1] ?? "")).filter(Boolean);

  if (qualRefs.length > 0) {
    // Resolve unquoted aliases from UPDATE/FROM/JOIN clauses to their real table names.
    const aliasMap = new Map<string, string>();
    const aliasPattern =
      /\b(?:UPDATE|FROM|JOIN)\s+(?:"public"\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s+(?:AS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\b/gi;
    for (const m of stripSqlComments(mutation.statementSql).matchAll(aliasPattern)) {
      const tbl = normalizeIdentifier(m[1] ?? m[2] ?? "");
      const alias = normalizeIdentifier(m[3] ?? m[4] ?? "");
      if (tbl && alias && !RESERVED_ALIAS_WORDS.has(alias.toLowerCase())) aliasMap.set(alias, tbl);
    }
    const refTables = qualRefs.map((r) => aliasMap.get(r) ?? r);
    if (!refTables.some((t) => t === mutation.table)) {
      // All refs resolve to other tables. Confirm no bare unqualified identifiers remain.
      const noQual = whereClause
        .replace(/"[^"]+"\s*\.\s*(?:"[^"]+"|\w+)/g, " ")
        .replace(/\b[A-Za-z_][A-Za-z0-9_]*\s*\."[^"]+"/g, " ")
        .replace(/\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*/g, " ")
        .replace(/'(?:[^']|'')*'/g, " ");
      const SQL_KW =
        /\b(?:AND|OR|NOT|IN|EXISTS|LIKE|IS|NULL|TRUE|FALSE|BETWEEN|CASE|WHEN|THEN|END|CAST|AS|ANY|ALL|SOME)\b/gi;
      if (!/\b[A-Za-z_][A-Za-z0-9_]*\b/.test(noQual.replace(SQL_KW, " "))) return false;
    }
  }

  return true;
}

/**
 * Index just past the mutation's own body: the first top-level `;` after the
 * mutation keyword, the `)` closing an enclosing CTE, or end of input.
 *
 * The size rules scan a whole `splitSqlStatements` unit, which is safe for them
 * because a missed finding only costs a perf warning. The security rule cannot
 * afford that. A `DO $$ ... $$` block, or a segment between two
 * `--> statement-breakpoint` markers, holds several statements in one unit — and
 * an unbounded scan lets a *later* statement's `WHERE` vouch for an earlier
 * unqualified write.
 */
function mutationBodyEnd(sql: string, startIndex: number): number {
  let depth = 0;
  let index = startIndex;

  while (index < sql.length) {
    const next = skipSqlTrivia(sql, index);
    if (next !== index) {
      index = next;
      continue;
    }

    const char = sql[index];
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 0) return index;
      depth -= 1;
      index += 1;
      continue;
    }
    if (char === ";" && depth === 0) return index;
    index += 1;
  }

  return sql.length;
}

/** Left-hand side of a `SET` assignment, i.e. everything before its top-level `=`. */
function assignmentTarget(assignment: string): string {
  let depth = 0;
  let index = 0;

  while (index < assignment.length) {
    const next = skipSqlTrivia(assignment, index);
    if (next !== index) {
      index = next;
      continue;
    }

    const char = assignment[index];
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (char === "=" && depth === 0) return assignment.slice(0, index);
    index += 1;
  }

  return "";
}

/**
 * Columns assigned by an `UPDATE`'s `SET` clause.
 *
 * Handles both `SET a = 1, b = 2` and the multi-column `SET (a, b) = (1, 2)`
 * form. Sub-selects are skipped by paren depth, so `SET a = (SELECT ... FROM y)`
 * does not leak `y`'s columns.
 */
function updateSetColumns(mutation: MutationInfo, endIndex: number): string[] {
  const body = mutation.statementSql.slice(mutation.keywordIndex, endIndex);
  const setKeyword = keywordOccurrences(body, /^\bSET\b/i).find((entry) => entry.depth === 0);
  if (!setKeyword) return [];

  const assignmentsStart = setKeyword.index + setKeyword.length;
  const terminator = keywordOccurrences(body, /^\b(?:FROM|WHERE|RETURNING)\b/i).find(
    (entry) => entry.depth === 0 && entry.index >= assignmentsStart,
  );
  const assignments = body.slice(assignmentsStart, terminator?.index ?? body.length);

  return splitSqlList(assignments).flatMap((assignment) =>
    identifierList(assignmentTarget(assignment)),
  );
}

/**
 * True when the mutation writes every row of its target table.
 *
 * `TRUNCATE` has no predicate at all. For `UPDATE`/`DELETE` this reuses the
 * shared selectivity heuristic — which already rejects `WHERE true` and
 * `WHERE 1=1` — but over the mutation's own body only.
 */
function isUnqualifiedMutation(mutation: MutationInfo, endIndex: number): boolean {
  if (mutation.kind === "truncate") return true;
  return !hasSelectiveWhere({
    ...mutation,
    statementSql: mutation.statementSql.slice(0, endIndex),
  });
}

function hasLeadingOrderPrefix(
  supportIndex: CreateIndexInfo,
  orderColumns: readonly string[],
  statement: string,
): boolean {
  const indexedColumns = supportIndex.columns;
  const prefixLength = Math.min(indexedColumns.length, orderColumns.length);
  if (prefixLength === 0) return false;
  for (let index = 0; index < prefixLength; index += 1) {
    if (indexedColumns[index] !== orderColumns[index]) return false;
  }
  if (!supportIndex.predicate) return true;

  const indexPredicateTerms = predicateTerms(supportIndex.predicate);
  if (indexPredicateTerms.size === 0) return false;

  return batchWhereClausesBeforeOrderBy(statement).some((whereClause) => {
    const batchTerms = predicateTerms(whereClause);
    return [...indexPredicateTerms].every((term) => batchTerms.has(term));
  });
}

function hasOrderPrefixCompatibleIndex(
  supportIndex: CreateIndexInfo,
  orderColumns: readonly string[],
  statement: string,
): boolean {
  return hasLeadingOrderPrefix(supportIndex, orderColumns, statement);
}

function hasMatchingSupportIndex(
  indexes: readonly CreateIndexInfo[],
  mutation: MutationInfo,
  statement: string,
): boolean {
  const matchingIndexes = indexes.filter((index) => index.table === mutation.table);
  if (matchingIndexes.length === 0) return false;

  // ORDER BY columns are the batch-progression key. If the statement orders its
  // batch, the support index must cover the ordered key prefix using index key
  // columns; predicate-only overlap cannot stand in for an unindexed cursor.
  const orderCols = orderByColumns(statement);
  const allPredicateCols = new Set(predicateColumns(statement));
  if (allPredicateCols.size === 0) return true;

  if (orderCols.length > 0) {
    return matchingIndexes.some((index) =>
      hasOrderPrefixCompatibleIndex(index, orderCols, statement),
    );
  }

  return matchingIndexes.some((index) => {
    const indexedColumns = new Set([...index.columns, ...index.predicateColumns]);
    return [...allPredicateCols].some((col) => indexedColumns.has(col));
  });
}

function estimateSuffix(table: string, estimates: ReadonlyMap<string, TableSizeEstimate>): string {
  const estimate = estimates.get(table) ?? getTableSizeEstimate(table);
  if (!estimate) return "bucket=large";
  return `bucket=${estimate.bucket}, localRows=${estimate.localRows}, estimatedRows=${estimate.estimatedRows}`;
}

function makeFinding(
  rule: MigrationSafetyRule,
  migration: string,
  table: string,
  statement: string,
  estimates: ReadonlyMap<string, TableSizeEstimate>,
  detail?: string,
): MigrationSafetyFinding {
  const metadata = RULE_METADATA[rule];
  return {
    id: findingId(rule, migration, table, statement),
    rule,
    severity: metadata.severity,
    migration,
    table,
    statement: statementExcerpt(statement),
    message: `${metadata.message} (${detail ?? estimateSuffix(table, estimates)})`,
  };
}

function addFindingOnce(
  findings: MigrationSafetyFinding[],
  seen: Set<string>,
  finding: MigrationSafetyFinding,
): void {
  const key = `${finding.rule}:${finding.migration}:${finding.table}:${finding.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(finding);
}

function estimatesByTable(
  estimates: readonly TableSizeEstimate[] | undefined,
): ReadonlyMap<string, TableSizeEstimate> {
  if (!estimates) return new Map();
  return new Map(estimates.map((estimate) => [estimate.table, estimate]));
}

function tableIsLarge(table: string, estimates: ReadonlyMap<string, TableSizeEstimate>): boolean {
  if (estimates.size > 0) return estimates.get(table)?.bucket === "large";
  return isKnownLargeTable(table);
}

/**
 * Rule `unqualified-mutation-security-posture-column` (error).
 *
 * Fires on an `UPDATE` that assigns a column in `SECURITY_POSTURE_COLUMNS`
 * without a selective `WHERE`, and on an unqualified `DELETE`/`TRUNCATE` against
 * a table that holds one. `WHERE true` and `WHERE 1=1` count as unqualified.
 *
 * Deliberately independent of `table-size-estimates.ts`. The size rules model
 * *performance* risk, under which the statement that caused the incident —
 * `UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false;`
 * over a handful of rows — is the safest line in the migration. Under a security
 * lens it is the most dangerous one, because those rows are the egress gate. Row
 * count is the wrong axis for this class, and the size registry additionally
 * fails open: a table absent from it silently buckets as `"small"`.
 *
 * Opt out per statement with the shared ignore comment and a reason:
 * `-- paperclip:migration-safety-ignore unqualified-mutation-security-posture-column: <reason>`.
 * The `all` wildcard does not cover this rule (see `SECURITY_RULES`), and
 * baselining it requires a non-empty reason (see `assertSecurityBaselineReasons`).
 * Neither the drizzle journal nor "this only runs once" is a mitigation — `0138`
 * asserted exactly that in its header comment and it is what failed.
 *
 * Statement shapes the parser reaches (each covered by a test):
 * - plain `UPDATE ... SET ...` with and without `WHERE`
 * - `UPDATE ... SET ... FROM ...`
 * - `WITH x AS (...) UPDATE ...`, and `UPDATE` inside a `DO $$ ... $$` block
 * - segments split on `--> statement-breakpoint` and on a bare `;`, including a
 *   qualified statement following an unqualified one inside the same segment
 * - quoted, unquoted, and schema-qualified names (`public."company_secret_bindings"`)
 * - `SET (a, b) = (...)` multi-column assignment; mixed-case identifiers
 *
 * Known gaps — shapes the parser cannot reach, so the rule is silent on them:
 * - dynamic SQL: `EXECUTE format('UPDATE %I SET ...', tbl)`. The table and column
 *   are strings assembled at runtime, so no static parser can see them.
 * - a rule/trigger body that rewrites the posture column as a side effect of a
 *   write to some other table.
 * - a column renamed in one migration and mutated under its new name in another,
 *   until the registry is updated to the new name.
 * This rule narrows the class to the columns we named; detection of a posture
 * change nobody registered has to come from a runtime audit trail, not from here.
 */
function securityPostureFinding(
  mutation: MutationInfo,
  migration: string,
  statement: string,
  estimates: ReadonlyMap<string, TableSizeEstimate>,
): MigrationSafetyFinding | null {
  const rule = "unqualified-mutation-security-posture-column" as const;
  if (!isSecurityPostureTable(mutation.table)) return null;
  if (isIgnored(statement, rule)) return null;

  const endIndex = mutationBodyEnd(mutation.statementSql, mutation.keywordIndex);
  if (!isUnqualifiedMutation(mutation, endIndex)) return null;

  // DELETE and TRUNCATE remove the row, so they take every posture column with it.
  const columns =
    mutation.kind === "update"
      ? matchedPostureColumns(mutation.table, updateSetColumns(mutation, endIndex))
      : postureColumnsForTable(mutation.table);
  if (columns.length === 0) return null;

  return makeFinding(
    rule,
    migration,
    mutation.table,
    statement,
    estimates,
    `kind=${mutation.kind}, columns=${columns.join(", ")}`,
  );
}

export function analyzeMigrationSafety(
  migrations: readonly MigrationSafetyInput[],
  options: {
    readonly baselineIds?: readonly string[];
    readonly estimates?: readonly TableSizeEstimate[];
  } = {},
): MigrationSafetyResult {
  const findings: MigrationSafetyFinding[] = [];
  const seen = new Set<string>();
  const estimates = estimatesByTable(options.estimates);

  for (const migration of migrations) {
    const statements = splitSqlStatements(migration.sql);
    const migrationIndexes = statements.flatMap(parseCreateIndexes);

    for (const statement of statements) {
      for (const index of parseCreateIndexes(statement)) {
        if (
          tableIsLarge(index.table, estimates) &&
          !index.concurrently &&
          !isIgnored(statement, "large-create-index-not-concurrently")
        ) {
          addFindingOnce(
            findings,
            seen,
            makeFinding(
              "large-create-index-not-concurrently",
              migration.fileName,
              index.table,
              statement,
              estimates,
            ),
          );
        }
      }

      const allMutations = parseMutations(statement);

      for (const mutation of allMutations) {
        const finding = securityPostureFinding(mutation, migration.fileName, statement, estimates);
        if (finding) addFindingOnce(findings, seen, finding);
      }

      const mutations = allMutations.filter(
        (mutation) => mutation.kind !== "truncate" && tableIsLarge(mutation.table, estimates),
      );
      for (const mutation of mutations) {
        const hasSupportIndex = hasMatchingSupportIndex(migrationIndexes, mutation, statement);

        if (
          hasDoLoop(statement) &&
          !hasSupportIndex &&
          !isIgnored(statement, "loop-mutation-large-table")
        ) {
          addFindingOnce(
            findings,
            seen,
            makeFinding(
              "loop-mutation-large-table",
              migration.fileName,
              mutation.table,
              statement,
              estimates,
            ),
          );
        }

        if (
          hasBatchedLimitMutation(statement) &&
          !hasSupportIndex &&
          !isIgnored(statement, "batched-mutation-large-table-missing-index")
        ) {
          addFindingOnce(
            findings,
            seen,
            makeFinding(
              "batched-mutation-large-table-missing-index",
              migration.fileName,
              mutation.table,
              statement,
              estimates,
            ),
          );
        }

        if (
          !hasSelectiveWhere(mutation) &&
          !isIgnored(statement, "full-table-mutation-large-table")
        ) {
          addFindingOnce(
            findings,
            seen,
            makeFinding(
              "full-table-mutation-large-table",
              migration.fileName,
              mutation.table,
              statement,
              estimates,
            ),
          );
        }
      }
    }
  }

  const baselineIds = new Set(options.baselineIds ?? MIGRATION_SAFETY_BASELINE.map((entry) => entry.id));
  const foundIds = new Set(findings.map((finding) => finding.id));
  const newFindings = findings.filter((finding) => !baselineIds.has(finding.id));
  const baselineFindings = findings.filter((finding) => baselineIds.has(finding.id));
  const staleBaselineIds = [...baselineIds].filter((id) => !foundIds.has(id));

  return {
    findings,
    newFindings,
    baselineFindings,
    staleBaselineIds,
  };
}

async function readMigrations(): Promise<MigrationSafetyInput[]> {
  const files = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  return Promise.all(
    files.map(async (fileName) => ({
      fileName,
      sql: await readFile(new URL(`./migrations/${fileName}`, import.meta.url), "utf8"),
    })),
  );
}

function formatFinding(finding: MigrationSafetyFinding): string {
  return [
    `[${finding.rule}] ${finding.migration} table=${finding.table} severity=${finding.severity} id=${finding.id}`,
    finding.message,
    `Statement: ${finding.statement}`,
  ].join("\n");
}

function formatNewFindings(findings: readonly MigrationSafetyFinding[]): string {
  const rendered = findings.map(formatFinding).join("\n\n");
  const securityGuidance = findings.some((finding) => SECURITY_RULES.has(finding.rule))
    ? [
        "",
        "A security finding is listed below. Scope the statement with a WHERE that names",
        "the rows you mean, or opt out for that statement with an explicit reason:",
        "`-- paperclip:migration-safety-ignore <rule>: <reason>`. The `all` wildcard does",
        "not cover security rules, and journal-gating is not a mitigation.",
      ]
    : [];

  return [
    `Migration safety check found ${findings.length} new finding(s).`,
    "Add a same-migration support index, use CONCURRENTLY where applicable, or add",
    "`-- paperclip:migration-safety-ignore <rule>: <reason>` next to the statement.",
    ...securityGuidance,
    "",
    rendered,
  ].join("\n");
}

/**
 * Baselining a security finding must carry a reason.
 *
 * Silent baselining is the quietest way to defeat this rule: the finding still
 * exists, CI still goes green, and nothing in the diff says why. Enforced in the
 * checker rather than only in a test so it sits on the same path every migration
 * must cross.
 */
export function assertSecurityBaselineReasons(
  entries: readonly { readonly id: string; readonly rule: string; readonly reason: string }[] =
    MIGRATION_SAFETY_BASELINE,
): void {
  const unexplained = entries.filter(
    (entry) =>
      SECURITY_RULES.has(entry.rule as MigrationSafetyRule) && entry.reason.trim().length === 0,
  );
  if (unexplained.length === 0) return;

  throw new Error(
    [
      `Migration safety baseline has ${unexplained.length} security finding(s) with no reason.`,
      "A security rule may only be baselined with an explicit justification.",
      ...unexplained.map((entry) => `  ${entry.rule} id=${entry.id}`),
    ].join("\n"),
  );
}

async function main() {
  assertSecurityBaselineReasons();
  const result = analyzeMigrationSafety(await readMigrations());

  if (result.newFindings.length > 0) {
    throw new Error(formatNewFindings(result.newFindings));
  }

  const staleSuffix = result.staleBaselineIds.length > 0
    ? ` (${result.staleBaselineIds.length} stale baseline id(s) ignored)`
    : "";
  console.log(
    `Migration safety check passed: ${result.baselineFindings.length} historical finding(s) covered by baseline${staleSuffix}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`${basename(process.argv[1])}: ${detail}`);
    process.exitCode = 1;
  }
}
