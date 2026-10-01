import { refusalSentenceKey } from "@/lib/authority-issues";
import { CATALOGS, type TranslationKey } from "@/lib/i18n";

/**
 * The sentence for a diagnosis code, from the cockpit's own catalogue.
 *
 * A diagnosis code is one of four families — a changed approval or an
 * unavailable connector (said here), a request or storage refusal (said by the
 * approval dialog), or a manifest issue (said there too). The sentence is the
 * one the approval dialog already shows for the same code, so the two places
 * cannot word one block differently. Undefined for a code this build has no
 * sentence for: the caller shows the engine's value, marked as one.
 */
export function diagnosisCauseKey(code: string): TranslationKey | undefined {
  const own = `diagnosis.code.${code}`;
  if (Object.hasOwn(CATALOGS.en, own)) return own as TranslationKey;
  const refusal = refusalSentenceKey(code);
  if (refusal) return refusal;
  const issue = `authority.issue.${code}`;
  if (Object.hasOwn(CATALOGS.en, issue)) return issue as TranslationKey;
  return undefined;
}

/** What a repair request answered when it opened nothing new to review. */
export type RepairStatus = "rejected" | "applied" | "stale";

/**
 * A repair request returns the candidate that covers the block. Only a
 * `proposed` one has a card to review; every other status is a decision
 * already taken for this version, and the reader is told which.
 */
export function diagnosisNote(status: string): RepairStatus {
  if (status === "rejected") return "rejected";
  if (status === "applied") return "applied";
  return "stale";
}
