import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { skills as skillsTable } from "../../db/schema/index.ts";

export const SKILL_GATED_TOOLS: Readonly<Record<string, string>> = {
  approve_patch_candidate: "self-healing",
  edit_workflow_patch: "workflow-authoring",
  inspect_workflow: "workflow-authoring",
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

export function requiredSkillFor(toolName: string): string | undefined {
  return SKILL_GATED_TOOLS[toolName];
}

export async function requiredSkillForTenant(
  toolName: string,
  tenant_id: string,
  db: Db,
): Promise<string | undefined> {
  const gates = await loadGatesForTenant(tenant_id, db);
  return gates[toolName] ?? SKILL_GATED_TOOLS[toolName];
}

export function filterBySkillGate<T extends { name: string }>(
  tools: T[],
  loadedSkills: ReadonlyArray<string>,
): T[] {
  return tools.filter((t) => {
    const req = requiredSkillFor(t.name);
    return !req || loadedSkills.includes(req);
  });
}

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

export function resetGateCache(tenant_id?: string): void {
  if (tenant_id) DB_CACHE.delete(tenant_id);
  else DB_CACHE.clear();
}

async function loadGatesForTenant(tenant_id: string, db: Db): Promise<Record<string, string>> {
  const now = Date.now();
  const cached = DB_CACHE.get(tenant_id);
  if (cached && cached.expires_at > now) return cached.gates;

  const rows = await db
    .select({
      slug: skillsTable.slug,
      gates_tools: skillsTable.gates_tools,
    })
    .from(skillsTable)
    .where(sql`${skillsTable.tenant_id} = ${tenant_id} AND ${skillsTable.slug} IS NOT NULL`);

  const map: Record<string, string> = {};
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
