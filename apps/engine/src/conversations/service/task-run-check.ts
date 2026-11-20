import type { Db } from "../../db/client.ts";
import { getTaskRunCheck, withoutTaskRunCheck } from "../core/draft.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";

export async function clearTaskRunCheck(
  db: Db,
  scope: { tenant_id: string; conversation_id: string },
): Promise<void> {
  const draft = await loadDraft(scope.tenant_id, scope.conversation_id, db);
  if (!getTaskRunCheck(draft)) return;
  await appendSnapshot(scope.tenant_id, scope.conversation_id, withoutTaskRunCheck(draft), db);
}
