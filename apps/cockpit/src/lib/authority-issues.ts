// Why an approval is not available, in words the person deciding can act on.
//
// The engine knows precisely: which step, which code, and for a contradicted
// folder the key the step really wrote. The review surfaces said "Grenzen
// geändert" and stopped there — four words for a state that names a step and a
// reason. A reviewer who cannot see the reason cannot judge the approval, and
// the two folder mistakes that reached production were invisible for exactly
// this length of time.

import type { components } from "../api/schema";

type Manifest = components["schemas"]["WorkflowEffectManifest"];
type Preview = components["schemas"]["WorkflowAuthorityPreview"];
type IssueCode = Manifest["issues"][number]["code"];

/** One reason, ready to render: a heading, the step it belongs to, and the
 *  concrete values when the engine supplied them. */
export interface AuthorityIssue {
  /** Stable key for React and for grouping; unique per (call path, step, code). */
  key: string;
  step_id: string;
  code: IssueCode;
  /** i18n key for the sentence describing this code. */
  messageKey: `authority.issue.${IssueCode}`;
  /** Which called workflow it came through, if any. */
  call_step_id: string | null;
  /** Filled only for a contradicted folder. */
  evidence?: { declared_prefix: string; observed_key: string };
}

/**
 * Every reason this version cannot be approved, newest concern first.
 *
 * Order is the manifest's own: own steps before called ones, then by step id.
 * That is the order the approval itself is written in, so the list reads the
 * same way as what it refuses.
 */
export function authorityIssues(preview: Preview | null | undefined): AuthorityIssue[] {
  const issues = preview?.manifest?.issues ?? [];
  const evidence = new Map(
    (preview?.boundary_contradictions ?? []).map((entry) => [entry.step_id, entry]),
  );
  return issues.map((issue) => {
    const call_step_id = issue.call_path?.[0] ?? null;
    const seen = evidence.get(issue.step_id);
    return {
      key: JSON.stringify([issue.call_path ?? [], issue.step_id, issue.code]),
      step_id: issue.step_id,
      code: issue.code,
      messageKey: `authority.issue.${issue.code}` as const,
      call_step_id,
      ...(issue.code === "boundary_contradicted_by_history" && seen
        ? {
            evidence: {
              declared_prefix: seen.declared_prefix,
              observed_key: seen.observed_key,
            },
          }
        : {}),
    };
  });
}

/** A step this version could not bind at all, reported beside the issues. */
export function unavailableSteps(preview: Preview | null | undefined): string[] {
  return preview?.unavailable_steps ?? [];
}
