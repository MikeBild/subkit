import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { applyKnowledgeSeedsWithRetry, loadEmbeddedKnowledgeSeeds } from "../knowledge/seed.ts";
import { errorFields, logger } from "../logging/index.ts";
import { applySkillSeedsWithRetry, loadEmbeddedSkillSeeds } from "../skills/seed.ts";

export async function applyWorkspaceContentSeeds(tenant_id: string, db: Db): Promise<void> {
  if (getConfig().operations.seed_skills_at_boot) {
    try {
      const skills = loadEmbeddedSkillSeeds().skills;
      if (skills.length > 0) await applySkillSeedsWithRetry(skills, tenant_id, db);
    } catch (error) {
      logger.error({
        module: "skills.seed",
        action: "seed.workspace_failed",
        msg: "skill seeds for a new workspace failed (non-fatal); the next engine start applies them",
        tenant_id,
        ...errorFields(error),
      });
    }
  }
  try {
    const knowledge = loadEmbeddedKnowledgeSeeds().knowledge;
    if (knowledge.length > 0) await applyKnowledgeSeedsWithRetry(knowledge, tenant_id, db);
  } catch (error) {
    logger.error({
      module: "knowledge.seed",
      action: "seed.workspace_failed",
      msg: "knowledge seeds for a new workspace failed (non-fatal); the next engine start applies them",
      tenant_id,
      ...errorFields(error),
    });
  }
}
