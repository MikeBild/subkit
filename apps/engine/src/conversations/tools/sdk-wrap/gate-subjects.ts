import type { Db } from "../../../db/client.ts";
import { getSkillCandidate } from "../../../skill-candidates/service.ts";

const MAX_SUBJECTS = 20;

async function candidateTitles(
  tenantId: string,
  ids: ReadonlyArray<unknown>,
  db: Db,
): Promise<string[]> {
  const titles: string[] = [];
  for (const id of ids.slice(0, MAX_SUBJECTS)) {
    if (typeof id !== "string") continue;
    const candidate = await getSkillCandidate(tenantId, id, db);
    if (candidate?.title) titles.push(candidate.title);
  }
  return titles;
}

export async function resolveGateSubjects(
  tool: string,
  args: Record<string, unknown>,
  tenantId: string,
  db: Db,
): Promise<{ titles: string[] } | null> {
  if (tool === "approve_skill_candidate") {
    const titles = await candidateTitles(tenantId, [args.candidate_id], db);
    return titles.length > 0 ? { titles } : null;
  }
  if (tool === "reject_skill_candidate" && Array.isArray(args.candidate_ids)) {
    const titles = await candidateTitles(tenantId, args.candidate_ids, db);
    return titles.length > 0 ? { titles } : null;
  }
  return null;
}
