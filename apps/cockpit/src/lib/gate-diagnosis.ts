import type { components } from "@/api/schema";
import { refusalSentenceKey } from "@/lib/authority-issues";
import type { AutomationRights } from "@/lib/automation-state";
import { CATALOGS, type TranslationKey } from "@/lib/i18n";

type GateDiagnosis = components["schemas"]["GateDiagnosis"];

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

/** A block the engine can compute a repair for — offered for the running version only. */
export function diagnosisRepairable(
  entry: GateDiagnosis,
  isCurrent: boolean,
  rights: Pick<AutomationRights, "write">,
): boolean {
  return Boolean(entry.fixer) && isCurrent && rights.write;
}

/**
 * The acts the diagnosis offers once, however many blocks ask for them: each
 * performs the same thing whichever block it stood in.
 *
 *   review   the filed repairs wait in one review sheet
 *   prepare  one trial run supplies the evidence for the whole version
 *   author   the steps only a change to the workflow removes — one conversation
 *
 * Proposing a computed repair is not among them: it files a different repair
 * for each step, and stays that step's own button.
 */
export interface DiagnosisActs {
  review: boolean;
  prepare: boolean;
  /** The step ids to hand to an author, in the diagnosis' order. Empty: none. */
  author: string[];
  /** The run the first of those steps was last refused in, for the conversation. */
  authorRunId: string | null;
}

export function diagnosisActs(
  diagnosis: {
    is_current: boolean;
    workflow_version_id?: string | null;
    diagnoses: readonly GateDiagnosis[];
  },
  rights: AutomationRights,
  /** Steps whose computed repair was refused for this version. */
  rejectedRepairs: readonly string[] = [],
): DiagnosisActs {
  const entries = diagnosis.diagnoses;
  const needsAuthor = rights.chat
    ? entries.filter(
        (entry) =>
          (!entry.fixer && entry.remedy_kind !== "prepare") ||
          rejectedRepairs.includes(entry.subject.step_id),
      )
    : [];
  return {
    review: entries.some(
      (entry) =>
        diagnosisRepairable(entry, diagnosis.is_current, rights) && Boolean(entry.candidate_id),
    ),
    prepare:
      rights.run &&
      Boolean(diagnosis.workflow_version_id) &&
      entries.some((entry) => entry.remedy_kind === "prepare"),
    author: [...new Set(needsAuthor.map((entry) => entry.subject.step_id))],
    authorRunId: needsAuthor[0]?.evidence.execution_id ?? null,
  };
}
