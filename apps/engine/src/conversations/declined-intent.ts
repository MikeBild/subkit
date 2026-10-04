import type { Executor } from "../db/client.ts";
import { appendSnapshot, loadDraft } from "./draft.ts";
import {
  authoringIntentFingerprint,
  type ConfirmIntent,
  intentHasDistinguishingAction,
} from "./intent-fingerprint.ts";
import { interpretConfirmDecision } from "./tools/ask-user/interpret-confirm.ts";

function confirmIntentFromInput(input: unknown): ConfirmIntent | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  return {
    ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
    commit_intent: record.commit_intent,
    target: record.target,
  };
}

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
    if (!confirm || !intentHasDistinguishingAction(confirm)) return;
    const draft = await loadDraft(p.tenant_id, p.conversation_id, p.db);
    const fingerprint = authoringIntentFingerprint(confirm, draft);
    if (!fingerprint || !draft.state) return;
    if (draft.state.last_denied_intent?.fingerprint === fingerprint) return;
    draft.state.last_denied_intent = { fingerprint, timestamp: new Date().toISOString() };
    await appendSnapshot(p.tenant_id, p.conversation_id, draft, p.db);
  } catch {}
}
