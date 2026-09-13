// Shared predicate: "is there a prior operator approval that authorizes
// a save-workflow commit in this conversation?".
//
// ONE source of truth, imported by BOTH gates that must agree:
//
//   - `commit-workflow.ts` — the prior-approval gate inside
//     `commitWorkflowAtomic` (`commit_gate.denied` / `no_prior_approval`).
//   - `tools/sdk-wrap/invoke.ts` — the loop confirm gate's `priorApproval`
//     input to `decideConfirm`, which skips the pre-execution confirm IFF
//     the commit gate would accept the same approval. This is the ONLY
//     shortcut past the pre-execution gate on any surface; every other write
//     pauses and is performed by the harness once the operator answers.
//
// Authorization is keyed on the AUTHORITATIVE field —
// `input.commit_intent.kind === "save_workflow_draft"` — NOT the
// cosmetic top-level `input.kind` enum (`save_workflow_draft |
// external_write | generic`). The production bug (a stuck conversation
// whose only valid approval carried `input.kind = "generic"` but
// `input.commit_intent.kind = "save_workflow_draft"`) was caused by the
// two gates keying on the cosmetic field and rejecting it. The
// authoritative `commit_intent` is what the harness auto-persist
// dispatcher routes on, so it is the only correct authorization field.

import { and, desc, eq } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { conversationElicitations } from "../../db/schema/index.ts";

/** A resolved `ask_user_confirm` row that authorizes a save-workflow commit. */
export interface PriorSaveWorkflowApproval {
  id: string;
  status: string;
  created_at: Date | null;
}

/**
 * True when this elicitation row authorizes a save-workflow commit:
 * `status === "resolved"` AND `output.confirmed === true` AND
 * `input.commit_intent.kind === "save_workflow_draft"`.
 *
 * The top-level `input.kind` is deliberately ignored — a `generic`-kinded
 * confirm carrying the right `commit_intent` is a valid approval.
 */
export function rowAuthorizesSaveWorkflow(row: {
  status: string;
  input: unknown;
  output: unknown;
}): boolean {
  if (row.status !== "resolved") return false;
  const output = row.output;
  if (typeof output !== "object" || output === null) return false;
  if ((output as { confirmed?: unknown }).confirmed !== true) return false;
  const input = row.input;
  if (typeof input !== "object" || input === null) return false;
  const commitIntent = (input as { commit_intent?: unknown }).commit_intent;
  if (typeof commitIntent !== "object" || commitIntent === null) return false;
  return (commitIntent as { kind?: unknown }).kind === "save_workflow_draft";
}

/**
 * Find the most recent resolved `ask_user_confirm` elicitation in this
 * conversation that authorizes a save-workflow commit (see
 * `rowAuthorizesSaveWorkflow`). Returns `null` when no such approval
 * exists.
 *
 * The scan reads every `ask_user_confirm` row newest-first and applies
 * the predicate in process — the `commit_intent` lives inside the jsonb
 * `input` column, and reaching into it via SQL would re-introduce the
 * lossy-namespace coupling this module exists to remove.
 */
export async function findPriorSaveWorkflowApproval(
  exec: Db,
  tenant_id: string,
  conversation_id: string,
): Promise<PriorSaveWorkflowApproval | null> {
  const rows = await exec
    .select({
      id: conversationElicitations.id,
      status: conversationElicitations.status,
      input: conversationElicitations.input,
      output: conversationElicitations.output,
      created_at: conversationElicitations.created_at,
    })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.conversation_id, conversation_id),
        eq(conversationElicitations.tool_name, "ask_user_confirm"),
      ),
    )
    .orderBy(desc(conversationElicitations.created_at));
  for (const row of rows) {
    if (rowAuthorizesSaveWorkflow(row)) {
      return { id: row.id, status: row.status, created_at: row.created_at };
    }
  }
  return null;
}
