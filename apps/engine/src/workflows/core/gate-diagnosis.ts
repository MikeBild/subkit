import type { GateDiagnosis } from "../gate-diagnosis.ts";
import {
  type GateFixPlan,
  planReportDeliveryDeclaration,
  planUtf8EncoderFix,
} from "../gate-fix.ts";
import type { ReportDeliveryBoundary } from "../report-delivery-boundary.ts";
import type { ReportMessageRefusal } from "./report-refusal.ts";
import { isReportMessageRefusal, type ReportDeliveryRefusal } from "./report-refusal.ts";

export function planForDiagnosis(
  definition: unknown,
  diagnosis: GateDiagnosis,
): GateFixPlan | null {
  if (diagnosis.fixer === "use_utf8_encoder")
    return planUtf8EncoderFix(definition, diagnosis.subject.step_id);
  if (diagnosis.fixer === "declare_report_delivery" && diagnosis.evidence.observed)
    return planReportDeliveryDeclaration(
      definition,
      diagnosis.subject.step_id,
      diagnosis.evidence.observed,
    );
  return null;
}

export function collapseDiagnoses(diagnoses: readonly GateDiagnosis[]): GateDiagnosis[] {
  const byFix = new Map<string, GateDiagnosis>();
  const seen = new Set<string>();
  const out: GateDiagnosis[] = [];
  for (const original of diagnoses) {
    const diagnosis = { ...original, evidence: { ...original.evidence } };
    const identity = `${diagnosis.subject.step_id}\u0000${diagnosis.code}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (diagnosis.fixer) {
      const key = `${diagnosis.subject.step_id}\u0000${diagnosis.fixer}`;
      const kept = byFix.get(key);
      if (kept) {
        if (!kept.evidence.execution_id && diagnosis.evidence.execution_id)
          kept.evidence.execution_id = diagnosis.evidence.execution_id;
        continue;
      }
      byFix.set(key, diagnosis);
    }
    out.push(diagnosis);
  }
  return out;
}

type Remedy = Pick<GateDiagnosis, "evidence" | "remedy_kind" | "fixer">;

export function immediateReportRemedy(
  definition: unknown,
  stepId: string,
  reason: ReportDeliveryRefusal | null,
  executionId: string | undefined,
): Remedy | null {
  const evidence = executionId ? { execution_id: executionId } : {};
  if (reason === "not_utf8" || reason === "header_control_byte")
    return planUtf8EncoderFix(definition, stepId)
      ? { evidence, remedy_kind: "patch", fixer: "use_utf8_encoder" }
      : { evidence, remedy_kind: "author" };
  if (isReportMessageRefusal(reason)) return { evidence, remedy_kind: "author" };
  return null;
}

export function observedReportRemedy(
  definition: unknown,
  stepId: string,
  executionId: string | undefined,
  observation: Readonly<{
    execution_id: string;
    observed: Omit<ReportDeliveryBoundary, "kind">;
  }> | null,
): Remedy {
  const plan = observation
    ? planReportDeliveryDeclaration(definition, stepId, observation.observed)
    : null;
  return plan && observation
    ? {
        evidence: { execution_id: observation.execution_id, observed: observation.observed },
        remedy_kind: "declare",
        fixer: "declare_report_delivery",
      }
    : { evidence: executionId ? { execution_id: executionId } : {}, remedy_kind: "declare" };
}

export function gateEndpointKey(code: string): string {
  return `gate:${code}`;
}

type HeldStepFact = Readonly<{
  step_id: string;
  report_delivery_inspection?: Readonly<{ ok: true } | { ok: false; reason: ReportMessageRefusal }>;
}>;

export function heldInspected(
  steps: readonly HeldStepFact[] | undefined,
  step_id: string,
): boolean {
  const step = steps?.find((entry) => entry.step_id.replace(/\[[0-9]+\]$/, "") === step_id);
  return step?.report_delivery_inspection !== undefined;
}

export function heldReason(
  steps: readonly HeldStepFact[] | undefined,
  step_id: string,
): ReportMessageRefusal | null {
  const step = steps?.find((entry) => entry.step_id.replace(/\[[0-9]+\]$/, "") === step_id);
  const inspection = step?.report_delivery_inspection;
  return inspection && !inspection.ok ? inspection.reason : null;
}
