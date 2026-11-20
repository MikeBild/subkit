import { type AdmissionFacts, type AdmissionRequest, decideAdmission } from "./admission.ts";

export interface RunCoverageFacts {
  lifecycle: string | null;
  current_version_id: string | null;
  preview: { eligible: boolean; digest: string } | null;
  authority: { id: string; effect_manifest_digest: string } | null;
}

export type RunCoverage = { covered: true; authority_id: string } | { covered: false };

export const RUN_UNCOVERED: RunCoverage = { covered: false };

export const AUTHORITY_COVERED_RULE = "authority_covered";

export function decideRunCoverage(request: AdmissionRequest, facts: RunCoverageFacts): RunCoverage {
  const { preview, authority } = facts;
  if (request.hold_writes === true || preview === null || authority === null) return RUN_UNCOVERED;
  const stages: AdmissionFacts[] = [
    { stage: "requested_version" },
    {
      stage: "active_version",
      lifecycle: facts.lifecycle,
      current_version_id: facts.current_version_id,
    },
    { stage: "repeated_runs", eligible: preview.eligible },
    {
      stage: "authority",
      authority_digest: authority.effect_manifest_digest,
      boundary_digest: preview.digest,
    },
  ];
  return stages.every((stage) => decideAdmission(request, stage).kind === "admitted")
    ? { covered: true, authority_id: authority.id }
    : RUN_UNCOVERED;
}

export function admittedCoveringAuthority(
  rule: string,
  coverage: RunCoverage,
  admitted: { execution_authority_id?: unknown; hold_writes?: unknown },
): string | null {
  return rule === AUTHORITY_COVERED_RULE &&
    coverage.covered &&
    admitted.hold_writes === false &&
    admitted.execution_authority_id === coverage.authority_id
    ? coverage.authority_id
    : null;
}
