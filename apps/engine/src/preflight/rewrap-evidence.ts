import { createHash } from "node:crypto";

export interface RewrapAcknowledgement {
  all_producers_stopped: true;
  evidence: string;
}

export function rewrapEvidenceDigest(value: unknown): string {
  if (
    value === null ||
    typeof value !== "object" ||
    !("all_producers_stopped" in value) ||
    value.all_producers_stopped !== true
  ) {
    throw new Error("rewrap_all_producers_stopped_acknowledgement_required");
  }
  if (!("evidence" in value) || typeof value.evidence !== "string") {
    throw new Error("rewrap_stop_evidence_required");
  }
  const evidence = value.evidence.trim();
  if (evidence.length < 120 || evidence.length > 16000 || !/\S+\s+\S+/.test(evidence)) {
    throw new Error("rewrap_stop_evidence_invalid");
  }
  return createHash("sha256").update(evidence).digest("hex");
}
