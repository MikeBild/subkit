import { and, eq } from "drizzle-orm";
import type { Executor } from "../../../db/index.ts";
import { packageInstallItems } from "../../../db/index.ts";
import { getKnowledgeSource } from "../../../knowledge/index.ts";
import { logger } from "../../../logging/index.ts";
import { now } from "../../../utils/index.ts";
import { payloadHash } from "../format.ts";
import { knowledgePayload } from "../knowledge-payload.ts";

export async function recordAdmittedKnowledgeBaseline(
  exec: Executor,
  tenant_id: string,
  proposal_id: string,
  knowledge_source_id: string,
): Promise<void> {
  const source = await getKnowledgeSource(tenant_id, knowledge_source_id, exec);
  if (!source) return;
  const local_hash = payloadHash(await knowledgePayload(exec, tenant_id, source));
  const updated = await exec
    .update(packageInstallItems)
    .set({
      local_id: knowledge_source_id,
      local_hash,
      state: "admitted",
      updated_at: new Date(now()),
    })
    .where(
      and(
        eq(packageInstallItems.tenant_id, tenant_id),
        eq(packageInstallItems.kind, "knowledge"),
        eq(packageInstallItems.intake_proposal_id, proposal_id),
      ),
    )
    .returning({ item_key: packageInstallItems.item_key });
  for (const row of updated)
    logger.info({
      module: "identity.portability",
      action: "package.knowledge_baseline_recorded",
      msg: "imported knowledge admitted with a local baseline",
      tenant_id,
      item_key: row.item_key,
      knowledge_source_id,
      proposal_id,
    });
}
