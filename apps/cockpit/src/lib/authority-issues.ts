import type { components } from "../api/schema";

type Manifest = components["schemas"]["WorkflowEffectManifest"];
type Preview = components["schemas"]["WorkflowAuthorityPreview"];
type IssueCode = Manifest["issues"][number]["code"];

const REFUSAL_KEYS = [
  "no_boundary",
  "stricter_profile_applies",
  "report_delivery_unprepared",
  "report_delivery_unobserved",
  "report_delivery_unreachable",
  "report_delivery_contradicted",
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

export function refusalSentenceKey(code: string): `authority.refusal.${RefusalKey}` | undefined {
  return KNOWN_REFUSALS.has(code) ? `authority.refusal.${code as RefusalKey}` : undefined;
}

export interface AuthorityIssue {
  key: string;
  step_id: string;
  code: IssueCode;
  messageKey: `authority.issue.${IssueCode}`;
  call_step_id: string | null;
  evidence?: { declared_prefix: string; observed_key: string };
  reasonKey?: `authority.refusal.${RefusalKey}`;
}

export function authorityIssues(preview: Preview | null | undefined): AuthorityIssue[] {
  const issues = preview?.manifest?.issues ?? [];
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

export function unavailableSteps(preview: Preview | null | undefined): string[] {
  return preview?.unavailable_steps ?? [];
}
