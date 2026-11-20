import { dispatchCommitIntent } from "./commit-kinds.ts";
import { buildCommitContext } from "./context.ts";
import { finishCommitted, finishThrown } from "./finish.ts";
import { dispatchDecline, dispatchWithoutIntent, refuseOnReadonlyChat } from "./gates.ts";
import { extractCommitIntent } from "./synthetic.ts";
import { gateTaskRunIntent } from "./task-run-gate.ts";
import type { AutoPersistDispatch, AutoPersistInput, CommitOutcome } from "./types.ts";

export {
  extractCredentialFromFormOutput,
  maybeCacheDraftCredentialFromElicitation,
} from "./credential-cache.ts";
export { translateAutoPersistError } from "./error-translation.ts";
export type { SyntheticToolResult } from "./synthetic.ts";
export type { AutoPersistDispatch, AutoPersistInput } from "./types.ts";

export async function maybeAutoPersistFromElicitation(
  p: AutoPersistInput,
): Promise<AutoPersistDispatch> {
  const stored = extractCommitIntent(p.elicitation.input);
  if (!stored) return dispatchWithoutIntent(p);
  const declined = await dispatchDecline(p, stored);
  if (declined) return declined;
  const taskRun = await gateTaskRunIntent(p, stored);
  if ("refused" in taskRun) return taskRun.refused;
  const intent = taskRun.intent;
  const gated = await refuseOnReadonlyChat(p, intent);
  if (gated) return gated;
  const ctx = await buildCommitContext(p);
  let outcome: CommitOutcome;
  try {
    outcome = await dispatchCommitIntent({ p, intent, ctx });
  } catch (err) {
    return finishThrown(p, intent, err);
  }
  return finishCommitted(p, intent, outcome);
}
