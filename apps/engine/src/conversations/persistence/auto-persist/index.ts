import { dispatchCommitIntent } from "./commit-kinds.ts";
import { buildCommitContext } from "./context.ts";
import { finishCommitted, finishThrown } from "./finish.ts";
import { dispatchDecline, dispatchWithoutIntent, refuseOnReadonlyChat } from "./gates.ts";
import { extractCommitIntent } from "./synthetic.ts";
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
  const intent = extractCommitIntent(p.elicitation.input);
  if (!intent) return dispatchWithoutIntent(p);
  const gated = (await dispatchDecline(p, intent)) ?? (await refuseOnReadonlyChat(p, intent));
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
