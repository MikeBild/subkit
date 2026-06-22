// Recency-aware resolution of the conversation's loaded skills.
//
// The smart skill loader splits an ever-loaded skill into two render
// modes per turn:
//
//   - FULL BODY — the skill is relevant to THIS turn (in the recency
//     window). Its slug arrives in `loaded_skill_slugs`. The assembler
//     renders the whole body via `formatSkill`.
//   - INDEX ONLY — the skill aged out of the full-body window but is
//     still loaded (within the retention horizon). Its slug arrives in
//     `loaded_skill_membership` but NOT in `loaded_skill_slugs`. The
//     assembler renders a one-liner via `formatSkillIndex("Loaded", …)`
//     so the slug stays referenceable and `load_skill`-reaffirmable.
//
// This module owns the DB resolution of BOTH sets. It is a per-concern
// split out of the assembler body: the inputs are the two slug lists +
// the already-in-scope skills, the output is two skill arrays the
// assembler renders. Keeping it here keeps the assembler under its
// size ceiling without producing a barrel — there is real domain logic
// (slug↔id↔scope de-duplication and the index-safety contract) here.

import type { Executor } from "../../../db/client.ts";
import { getSkill, getSkillBySlug } from "../../../skills/service.ts";
import type { Skill } from "../../../skills/types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a slug-or-id ref to a Skill, routing by shape so a bare slug
 *  never hits the uuid-typed id column. */
async function fetchSkillRef(tenant_id: string, ref: string, db: Executor): Promise<Skill | null> {
  return UUID_RE.test(ref)
    ? await getSkill(tenant_id, ref, db)
    : await getSkillBySlug(tenant_id, ref, db);
}

export interface LoadedSkillSets {
  /** Skills rendered with their FULL body this turn (recency window). */
  fullBody: Skill[];
  /** Skills rendered as a one-liner in the "Loaded" index (demoted but
   *  still loaded — index-safety so no skill disappears). */
  index: Skill[];
}

/**
 * Resolve the full-body and index-only skill sets for a turn.
 *
 * `loadedSkillSlugs` (the recency window) → full bodies. Each entry is a
 * slug or an id. Resolution order is slug → id — slug first because
 * `loaded_skill_slugs` carries slugs from the seed-loader and the
 * auto-loaded authoring constants. Skills already in `skillsApplicable`
 * (returned by `retrieveApplicableSkills` for the in-scope global /
 * connector / workflow ids) are skipped — they already render via their
 * scope index, so re-fetching would duplicate them.
 *
 * Previously this path fetched ALL active skills via `listSkills` just to
 * find a handful of matches by slug — one of the hottest per-turn
 * allocations (2026-05-28 memory-stuck incident). Now we hit the indexed
 * primary-key / unique-slug lookups per ref, which is far cheaper on both
 * wall-time and heap than streaming the whole skills table into JS.
 *
 * `membershipSlugs` is the INDEX-SAFETY set. Every EVER-loaded skill must
 * stay referenceable even after it ages out of the full-body window.
 * `retrieveApplicableSkills` only returns ALL global skills plus
 * connector / workflow skills for in-scope ids, so a demoted skill that
 * is connector / workflow-scoped-but-out-of-scope, or experimental
 * (`load_skill`-only), appears in NONE of the scope indexes and would
 * vanish. We resolve any membership slug that is not already full-body
 * and not in any scope index and render it through the "Loaded" index
 * (one line each; `load_skill` re-fetches the full body).
 *
 * Best-effort: an unresolvable / cross-tenant ref is silently dropped
 * (it surfaces as a missing skill in the trace, never a body injection).
 */
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
