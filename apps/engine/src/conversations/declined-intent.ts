// Declined-intent guard — a "no" stays a "no" within one conversation.
//
// When the operator DECLINES an `ask_user_confirm`, we stamp the fingerprint
// of the declined intent onto the draft's AuthoringState. Before re-proposing
// the same action (see tools/ask-user/confirm.ts), the confirm tool compares
// the candidate fingerprint against this stamp: an identical re-proposal in
// the same conversation is answered "you already declined this" instead of
// re-prompting. An edited draft yields a different fingerprint and falls
// through to a normal prompt.
//
// Fail-open throughout: any error here leaves the draft untouched, so the
// worst case is the model asks once more — never a fabricated block.

import type { Executor } from "../db/client.ts";
import { appendSnapshot, loadDraft } from "./draft.ts";
import { authoringIntentFingerprint, type ConfirmIntent } from "./intent-fingerprint.ts";
import { interpretConfirmDecision } from "./tools/ask-user/interpret-confirm.ts";

/** Extract the confirm intent projection from a stored elicitation input. */
function confirmIntentFromInput(input: unknown): ConfirmIntent | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  return {
    ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
    commit_intent: record.commit_intent,
    target: record.target,
  };
}

/**
 * When a resolved `ask_user_confirm` was declined, record its intent
 * fingerprint on the draft so a byte-identical re-proposal short-circuits.
 * No-op for any other tool, for non-declines, or when the intent can't be
 * fingerprinted. Never throws.
 */
export async function recordDeniedIntentIfDeclined(p: {
  tenant_id: string;
  conversation_id: string;
  elicitation: { tool_name: string; input: unknown };
  output: unknown;
  db: Executor;
}): Promise<void> {
  try {
    if (p.elicitation.tool_name !== "ask_user_confirm") return;
    if (interpretConfirmDecision(p.output) !== "declined") return;
    const confirm = confirmIntentFromInput(p.elicitation.input);
    if (!confirm) return;
    const draft = await loadDraft(p.tenant_id, p.conversation_id, p.db);
    const fingerprint = authoringIntentFingerprint(confirm, draft);
    if (!fingerprint || !draft.state) return;
    draft.state.last_denied_intent = { fingerprint, timestamp: new Date().toISOString() };
    await appendSnapshot(p.tenant_id, p.conversation_id, draft, p.db);
  } catch {
    // Fail-open: a decline that we can't record just means the next
    // identical proposal prompts again — the honest fallback.
  }
}
