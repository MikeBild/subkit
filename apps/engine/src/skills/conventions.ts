import { and, eq, inArray, or, sql } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { connectors, skills, workflows } from "../db/schema/index.ts";
import { isUuid } from "../utils/index.ts";
import { type SkillRule, SkillRuleSchema } from "./types.ts";

export type ConventionLevel = "workflow" | "connector" | "global";

const LEVEL_RANK: Record<ConventionLevel, number> = { workflow: 0, connector: 1, global: 2 };

export interface AppliedConvention {
  level: ConventionLevel;
  skill_id: string;
  skill_title: string;
  skill_version: number;
  rule: SkillRule;
}

export interface ConventionConflict {
  key: string;
  level: ConventionLevel;
  conventions: AppliedConvention[];
}

export interface ActiveConventions {
  conventions: AppliedConvention[];
  conflicts: ConventionConflict[];
}

export interface ConventionScope {
  connector_ids?: readonly string[] | undefined;
  workflow_id?: string | null | undefined;
  categories?: readonly string[] | undefined;
}

export const NO_CONVENTIONS: ActiveConventions = { conventions: [], conflicts: [] };

export function conventionKey(rule: SkillRule): string | null {
  switch (rule.type) {
    case "timezone":
    case "locale":
    case "currency":
    case "delivery_default":
      return rule.type;
    case "connector_preference":
      return `connector_preference:${rule.payload.environment}`;
    case "naming":
      return `naming:${rule.payload.applies_to.toLowerCase()}`;
    case "glossary_term":
      return `glossary_term:${rule.payload.term.toLowerCase()}`;
    case "field_semantics":
      return `field_semantics:${rule.payload.field}`;
    case "pitfall":
      return null;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function compare(a: AppliedConvention, b: AppliedConvention): number {
  return (
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
    (a.rule.type < b.rule.type ? -1 : a.rule.type > b.rule.type ? 1 : 0) ||
    (a.rule.rule_id < b.rule.rule_id ? -1 : a.rule.rule_id > b.rule.rule_id ? 1 : 0) ||
    (a.skill_id < b.skill_id ? -1 : a.skill_id > b.skill_id ? 1 : 0)
  );
}

export function resolveConventions(entries: readonly AppliedConvention[]): ActiveConventions {
  const sorted = [...entries].sort(compare);
  const winningLevel = new Map<string, ConventionLevel>();
  for (const entry of sorted) {
    const key = conventionKey(entry.rule);
    if (key && !winningLevel.has(key)) winningLevel.set(key, entry.level);
  }
  const conventions = sorted.filter((entry) => {
    const key = conventionKey(entry.rule);
    return key === null || winningLevel.get(key) === entry.level;
  });
  const groups = new Map<string, AppliedConvention[]>();
  for (const entry of conventions) {
    const key = conventionKey(entry.rule);
    if (key) groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const conflicts: ConventionConflict[] = [];
  for (const [key, group] of groups) {
    const payloads = new Set(group.map((entry) => canonical(entry.rule.payload)));
    const level = group[0]?.level;
    if (payloads.size > 1 && level) conflicts.push({ key, level, conventions: group });
  }
  conflicts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { conventions, conflicts };
}

function parsedRules(value: unknown): SkillRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const parsed = SkillRuleSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
}

async function scopeCategories(
  db: Executor,
  tenant_id: string,
  connectorIds: string[],
  workflowId: string | null,
): Promise<string[]> {
  const found: string[] = [];
  if (connectorIds.length > 0) {
    const rows = await db
      .select({ category: connectors.category })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), inArray(connectors.id, connectorIds)));
    for (const row of rows) if (row.category) found.push(row.category);
  }
  if (workflowId) {
    const rows = await db
      .select({ category: workflows.category })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflowId)))
      .limit(1);
    for (const row of rows) if (row.category) found.push(row.category);
  }
  return found;
}

export async function loadActiveConventions(
  tenant_id: string,
  scope: ConventionScope,
  exec?: Executor,
): Promise<ActiveConventions> {
  const db = exec ?? getDb();
  const connectorIds = [...new Set((scope.connector_ids ?? []).filter((id) => isUuid(id)))];
  const workflowId = scope.workflow_id && isUuid(scope.workflow_id) ? scope.workflow_id : null;
  const levels = [eq(skills.scope, "global")];
  if (connectorIds.length > 0)
    levels.push(
      and(eq(skills.scope, "connector"), inArray(skills.connector_id, connectorIds)) ?? sql`false`,
    );
  if (workflowId)
    levels.push(
      and(eq(skills.scope, "workflow"), eq(skills.workflow_id, workflowId)) ?? sql`false`,
    );
  const rows = await db
    .select({
      id: skills.id,
      title: skills.title,
      version: skills.version,
      scope: skills.scope,
      rules: skills.rules,
      domains: skills.domains,
    })
    .from(skills)
    .where(
      and(
        eq(skills.tenant_id, tenant_id),
        eq(skills.lifecycle, "active"),
        sql`jsonb_array_length(${skills.rules}) > 0`,
        or(...levels),
      ),
    );
  if (rows.length === 0) return NO_CONVENTIONS;
  const categories = new Set([
    ...(scope.categories ?? []),
    ...(await scopeCategories(db, tenant_id, connectorIds, workflowId)),
  ]);
  const entries = rows.flatMap((row) => {
    const domains = Array.isArray(row.domains) ? row.domains : [];
    if (domains.length > 0 && !domains.some((domain) => categories.has(domain))) return [];
    return parsedRules(row.rules).map(
      (rule): AppliedConvention => ({
        level: row.scope,
        skill_id: row.id,
        skill_title: row.title,
        skill_version: row.version,
        rule,
      }),
    );
  });
  return resolveConventions(entries);
}
