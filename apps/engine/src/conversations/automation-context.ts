import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { can } from "../rbac/evaluator.ts";
import { inspectScheduleAutomation } from "../scheduler/automation-status.ts";
import { listSchedules } from "../scheduler/repo.ts";

/** Fresh, permission-scoped evidence. A preview cannot supply this status. */
export async function renderAutomationContext(
  tenant_id: string,
  workflow_id: string | null | undefined,
  principal: ResolvedPrincipal | null | undefined,
  db: Db,
): Promise<string> {
  if (!workflow_id) return "";
  const rule =
    "AUTOMATIC OPERATION: A saved or active workflow, an unpaused cadence, a successful held-write preview, and an answer to a business question are NOT execution permission. Never promise a next automatic run without fresh authorized status. If blocked, report the remaining action and direct the user to the automatic-run review in this chat; never ask to keep an already agreed schedule again. The chat provides a saved-change review dialog: it can atomically apply a draft and authorize supported bounded runs. For variable effects it can apply the draft without granting repeated runs, then prepare one concrete run for human review via the saved wf_<slug> tool. Keep the user in this chat; never provide external API commands or try engine calls through call_connector. Explain the next action in one sentence without tool names.";
  if (
    !principal ||
    principal.tenant_id !== tenant_id ||
    !(await can(db, { tenant_id, principal, permission: "schedule:read" })).allow
  )
    return `${rule}\nCurrent scheduling permission cannot be verified for this caller.`;
  const { rows } = await listSchedules(db, tenant_id, workflow_id);
  const statuses = await Promise.all(rows.map((row) => inspectScheduleAutomation(row, db)));
  return `${rule}\nCurrent scheduling evidence (read-only snapshot; no run reserved): ${JSON.stringify(statuses)}\nrepair_required: prepare a supported fixed boundary; do not declare repair complete from a green preview. approval_required: human review is still needed. activation_required: saved draft is not active. paused: automatic runs are disabled. authorized: permission exists now, subject to recheck when due.`;
}
