import type { components } from "@cli-core/engine-api/openapi";
import { refusalSentenceKey } from "@/features/grants/model/authority-issues";
import type { AutomationRights } from "@/features/grants/model/automation-state";
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

export type DiagnosisFix = "auto" | "review" | "prepare" | "chat";

export function diagnosisFix(
  entry: GateDiagnosis,
  diagnosis: { is_current: boolean; workflow_version_id?: string | null },
  rights: AutomationRights,
  rejectedRepairs: readonly string[] = [],
): DiagnosisFix | null {
  const rejected = rejectedRepairs.includes(entry.subject.step_id);
  if (!rejected && diagnosisRepairable(entry, diagnosis.is_current, rights))
    return entry.candidate_id ? "review" : "auto";
  if (entry.remedy_kind === "prepare" && !rejected)
    return rights.run && diagnosis.workflow_version_id ? "prepare" : null;
  if (rejected || !entry.fixer) return rights.chat ? "chat" : null;
  return null;
}
