import type { components } from "@/api/schema";
import { refusalSentenceKey } from "@/lib/authority-issues";
import type { AutomationRights } from "@/lib/automation-state";
import { CATALOGS, type TranslationKey } from "@/lib/i18n";

type GateDiagnosis = components["schemas"]["GateDiagnosis"];

export function diagnosisCauseKey(code: string): TranslationKey | undefined {
  const own = `diagnosis.code.${code}`;
  if (Object.hasOwn(CATALOGS.en, own)) return own as TranslationKey;
  const refusal = refusalSentenceKey(code);
  if (refusal) return refusal;
  const issue = `authority.issue.${code}`;
  if (Object.hasOwn(CATALOGS.en, issue)) return issue as TranslationKey;
  return undefined;
}

export type RepairStatus = "rejected" | "applied" | "stale";

export function diagnosisNote(status: string): RepairStatus {
  if (status === "rejected") return "rejected";
  if (status === "applied") return "applied";
  return "stale";
}

export function diagnosisRepairable(
  entry: GateDiagnosis,
  isCurrent: boolean,
  rights: Pick<AutomationRights, "write">,
): boolean {
  return Boolean(entry.fixer) && isCurrent && rights.write;
}

export interface DiagnosisActs {
  review: boolean;
  prepare: boolean;
  author: string[];
  authorRunId: string | null;
}

export function diagnosisActs(
  diagnosis: {
    is_current: boolean;
    workflow_version_id?: string | null;
    diagnoses: readonly GateDiagnosis[];
  },
  rights: AutomationRights,
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
