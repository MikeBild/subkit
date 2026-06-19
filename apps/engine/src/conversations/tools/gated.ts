// Skill-gated tool map.
//
// When a tool requires a specific skill to have been loaded via
// `load_skill`, the loop filters it out of the palette until the
// requirement is met.
//
// Two sources of gate data, applied in priority order:
//
//   1. The hard-coded `SKILL_GATED_TOOLS` below — engineering invariants
//      for tools that can never be used safely without a given skill.
//
//   2. The `skills.gates_tools` column, populated by the seed loader
//      (see `skills/seed.ts`). Operators who write their own skills can
//      also set this per tenant to extend the default gate map.
//
// The DB-backed layer is cached per-tenant with a 60-second TTL so loop
// dispatch doesn't issue a SELECT for every turn.

import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { skills as skillsTable } from "../../db/schema/index.ts";

/** Hard-coded baseline gates.
 *
 * Tools that
 * mutate or author tenant-visible artifacts are not exposed until the
 * matching skill is in context. Forces the model to read the skill
 * (envelope contract, JSONata cheatsheet, recipe) before authoring,
 * which is what eliminates the "guess and patch" loop on $scope paths.
 */
export const SKILL_GATED_TOOLS: Readonly<Record<string, string>> = {
  approve_patch_candidate: "self-healing",
  // Workflow authoring + edit — the model must load workflow-authoring
  // (which now requires data-handling + the protocol skill upstream)
  // before it can build/edit a workflow draft.
  build_workflow: "workflow-authoring",
  propose_step: "workflow-authoring",
  update_param: "workflow-authoring",
  edit_workflow_patch: "workflow-authoring",
  inspect_workflow: "workflow-authoring",
  // Connector authoring — same pattern; load connector-creation-guidance
  // before drafting.
  start_connector_from_description: "connector-creation-guidance",
  start_connector_from_template: "connector-creation-guidance",
  update_connector_draft: "connector-creation-guidance",
};

type CacheEntry = {
  gates: Record<string, string>;
  expires_at: number;
};

const DB_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

/** Synchronous lookup using only the hardcoded baseline. */
export function requiredSkillFor(toolName: string): string | undefined {
  return SKILL_GATED_TOOLS[toolName];
}

/** Async lookup that merges hardcoded + tenant-DB gates. First hit is
 *  authoritative: if multiple skills gate the same tool, the first
 *  row (deterministic by slug, then id) wins. */
export async function requiredSkillForTenant(
  toolName: string,
  tenant_id: string,
  db: Db,
): Promise<string | undefined> {
  const gates = await loadGatesForTenant(tenant_id, db);
  return gates[toolName] ?? SKILL_GATED_TOOLS[toolName];
}

/** Synchronous filter — uses only the hardcoded baseline. Sufficient
 *  for callers that do not yet have tenant context. */
export function filterBySkillGate<T extends { name: string }>(
  tools: T[],
  loadedSkills: ReadonlyArray<string>,
): T[] {
  return tools.filter((t) => {
    const req = requiredSkillFor(t.name);
    return !req || loadedSkills.includes(req);
  });
}

/** Tenant-aware filter — merges DB-driven gates with the baseline. */
export async function filterBySkillGateForTenant<T extends { name: string }>(
  tools: T[],
  loadedSkills: ReadonlyArray<string>,
  tenant_id: string,
  db: Db,
): Promise<T[]> {
  const gates = await loadGatesForTenant(tenant_id, db);
  return tools.filter((t) => {
    const req = gates[t.name] ?? SKILL_GATED_TOOLS[t.name];
    return !req || loadedSkills.includes(req);
  });
}

/** Reset the per-tenant cache. Tests call this to force a fresh DB read. */
export function resetGateCache(tenant_id?: string): void {
  if (tenant_id) DB_CACHE.delete(tenant_id);
  else DB_CACHE.clear();
}

async function loadGatesForTenant(tenant_id: string, db: Db): Promise<Record<string, string>> {
  const now = Date.now();
  const cached = DB_CACHE.get(tenant_id);
  if (cached && cached.expires_at > now) return cached.gates;

  // Pull every active skill that has non-empty `gates_tools`. We don't
  // need the body here — just the slug + gates array.
  const rows = await db
    .select({
      slug: skillsTable.slug,
      gates_tools: skillsTable.gates_tools,
    })
    .from(skillsTable)
    .where(sql`${skillsTable.tenant_id} = ${tenant_id} AND ${skillsTable.slug} IS NOT NULL`);

  const map: Record<string, string> = {};
  // Sort so the same dataset always yields the same winner when multiple
  // skills gate the same tool.
  const sorted = [...rows].sort((a, b) => (a.slug ?? "").localeCompare(b.slug ?? ""));
  for (const row of sorted) {
    const gates = (row.gates_tools ?? []) as string[];
    if (!row.slug || !Array.isArray(gates)) continue;
    for (const toolName of gates) {
      if (!(toolName in map)) map[toolName] = row.slug;
    }
  }
  DB_CACHE.set(tenant_id, { gates: map, expires_at: now + CACHE_TTL_MS });
  return map;
}
