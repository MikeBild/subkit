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

/**
 * The refusal codes a reader is given a sentence for.
 *
 * The manifest's own code is a blanket: every refused http boundary arrives as
 * `dynamic_request`, "where this request goes is decided at runtime". For a
 * step whose path is a constant that is simply untrue — and the engine knew
 * the real reason all along, it just reported it beside the manifest instead
 * of inside it. Listed explicitly rather than rendered from the raw code,
 * because a code with no sentence must fall back to the general one rather
 * than print an identifier at somebody.
 */
const REFUSAL_KEYS = [
  "no_boundary",
  "stricter_profile_applies",
  // Three situations the code above used to answer with one sentence. The
  // third is the one that matters: "let a preparation run" is the advice for
  // the first two and a circle for the third.
  "report_delivery_unprepared",
  "report_delivery_unobserved",
  "report_delivery_unreachable",
  "connector_adds_query",
  "target_unresolved",
  "path_unsupported",
  "partial_segment_placeholder",
  "runtime_header",
  "runtime_value_outside_path_and_body",
  "query_placeholder_unsupported",
  "pagination_unbounded",
  "pagination_param_conflict",
  "delete_requires_destructive",
  "delete_requires_enum",
  "variable_in_base_prefix",
  "enum_value_unroutable",
  "boundary_invalid",
  "variables_mismatch",
  "not_http_step",
  "no_scope",
  "scope_invalid",
  "unsupported_method",
  "delete_with_body",
  "runtime_value_outside_key",
  "query_or_headers_present",
  "unsupported_option",
  "content_type_invalid",
  "base_unresolved",
] as const;
export type RefusalKey = (typeof REFUSAL_KEYS)[number];
const KNOWN_REFUSALS = new Set<string>(REFUSAL_KEYS);

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
  /**
   * The engine's own reason for this step, when it reported one and we have a
   * sentence for it. Shown INSTEAD of `messageKey`: the blanket code and the
   * precise reason are not two halves of one explanation, they are two
   * different statements, and one of them is wrong.
   */
  reasonKey?: `authority.refusal.${RefusalKey}`;
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
  // Keyed by call path and step, because a parent and a called child may use
  // the same step id and their refusals are different facts.
  const refusalKey = (entry: { step_id: string; call_path?: string[] }) =>
    `${(entry.call_path ?? []).join(">")}|${entry.step_id}`;
  const refusals = new Map<string, string>();
  for (const entry of [...(preview?.request_refusals ?? []), ...(preview?.storage_refusals ?? [])])
    refusals.set(refusalKey(entry), entry.reason);
  const evidence = new Map(
    (preview?.boundary_contradictions ?? []).map((entry) => [entry.step_id, entry]),
  );
  return issues.map((issue) => {
    const call_step_id = issue.call_path?.[0] ?? null;
    const seen = evidence.get(issue.step_id);
    const reason = refusals.get(refusalKey(issue));
    return {
      key: JSON.stringify([issue.call_path ?? [], issue.step_id, issue.code]),
      step_id: issue.step_id,
      code: issue.code,
      messageKey: `authority.issue.${issue.code}` as const,
      ...(reason && KNOWN_REFUSALS.has(reason)
        ? { reasonKey: `authority.refusal.${reason as RefusalKey}` as const }
        : {}),
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
