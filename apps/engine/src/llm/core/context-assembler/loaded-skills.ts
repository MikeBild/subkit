import type { Executor } from "../../../db/client.ts";
import { getSkill, getSkillBySlug } from "../../../skills/service.ts";
import type { Skill } from "../../../skills/types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fetchSkillRef(tenant_id: string, ref: string, db: Executor): Promise<Skill | null> {
  return UUID_RE.test(ref)
    ? await getSkill(tenant_id, ref, db)
    : await getSkillBySlug(tenant_id, ref, db);
}

interface LoadedSkillSets {
  fullBody: Skill[];
  index: Skill[];
}

export async function resolveLoadedSkills(
  tenant_id: string,
  loadedSkillSlugs: readonly string[],
  membershipSlugs: readonly string[],
  skillsApplicable: readonly Skill[],
  db: Executor,
): Promise<LoadedSkillSets> {
  const fullBody: Skill[] = [];
  const index: Skill[] = [];

  const scopeIds = new Set(skillsApplicable.map((s) => s.id));
  const existingIds = new Set(scopeIds);
  if (loadedSkillSlugs.length > 0) {
    for (const ref of loadedSkillSlugs) {
      if (existingIds.has(ref)) continue;
      const fetched = await fetchSkillRef(tenant_id, ref, db);
      if (fetched && !existingIds.has(fetched.id)) {
        fullBody.push(fetched);
        existingIds.add(fetched.id);
      }
    }
  }

  if (membershipSlugs.length > 0) {
    const fullBodyIds = new Set(fullBody.map((s) => s.id));
    const fullBodyRefs = new Set(loadedSkillSlugs);
    const seenIds = new Set<string>();
    for (const ref of membershipSlugs) {
      if (fullBodyRefs.has(ref) || scopeIds.has(ref) || fullBodyIds.has(ref)) continue;
      const fetched = await fetchSkillRef(tenant_id, ref, db);
      if (!fetched) continue;
      if (fullBodyIds.has(fetched.id) || scopeIds.has(fetched.id) || seenIds.has(fetched.id)) {
        continue;
      }
      index.push(fetched);
      seenIds.add(fetched.id);
    }
  }

  return { fullBody, index };
}
