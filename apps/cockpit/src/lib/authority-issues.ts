import type { components } from "@cli-core/engine-api/openapi";
import type { TranslationKey } from "@/lib/i18n";

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
  "connector_query_conflict",
  "connector_query_unresolved",
  "connector_query_needs_boundary",
  "target_unresolved",
  "path_unsupported",
  "partial_segment_placeholder",
  "runtime_header",
  "runtime_value_outside_path_and_body",
  "query_placeholder_unsupported",
  "pagination_unsupported",
  "pagination_body_unsupported",
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
  "mcp_not_a_tool_call",
  "mcp_no_boundary",
  "mcp_boundary_invalid",
  "mcp_tool_not_literal",
  "mcp_server_unresolved",
  "mcp_runtime_value_outside_arguments",
  "mcp_argument_placeholder_unsupported",
  "mcp_variables_mismatch",
  "mcp_caller_bound_mismatch",
  "mcp_write_needs_single_attempt",
  "mcp_tool_changed",
  "mcp_tool_unavailable",
] as const;
type RefusalKey = (typeof REFUSAL_KEYS)[number];
const KNOWN_REFUSALS = new Set<string>(REFUSAL_KEYS);

export function refusalSentenceKey(code: string): `authority.refusal.${RefusalKey}` | undefined {
  return KNOWN_REFUSALS.has(code) ? `authority.refusal.${code as RefusalKey}` : undefined;
}

interface AuthorityIssue {
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

interface UnavailableStep {
  step_id: string;
  inner_step_id: string | null;
  reasonKey?: `authority.refusal.${RefusalKey}`;
}

export function unavailableSteps(preview: Preview | null | undefined): UnavailableStep[] {
  const explained = new Set(
    authorityIssues(preview).flatMap((issue) =>
      issue.reasonKey ? [issue.call_step_id ?? issue.step_id] : [],
    ),
  );
  return (preview?.unavailable_steps ?? []).map((step_id) => {
    const refusal = explained.has(step_id)
      ? undefined
      : (preview?.request_refusals ?? []).find(
          (entry) =>
            KNOWN_REFUSALS.has(entry.reason) &&
            ((entry.call_path ?? []).length === 0
              ? entry.step_id === step_id
              : entry.call_path?.[0] === step_id),
        );
    const nested = (refusal?.call_path ?? []).length > 0;
    return {
      step_id,
      inner_step_id: refusal && nested ? refusal.step_id : null,
      ...(refusal
        ? { reasonKey: `authority.refusal.${refusal.reason as RefusalKey}` as const }
        : {}),
    };
  });
}

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export function authorityProblems(preview: Preview | null | undefined, t: Translate): string[] {
  return [
    ...authorityIssues(preview).map(
      (issue) =>
        `${
          issue.call_step_id
            ? t("authority.issueInCall", { step: issue.step_id, call: issue.call_step_id })
            : t("authority.issueStep", { step: issue.step_id })
        }: ${t(issue.reasonKey ?? issue.messageKey)}${
          issue.evidence
            ? ` ${t("authority.issueEvidence", {
                declared: issue.evidence.declared_prefix,
                observed: issue.evidence.observed_key,
              })}`
            : ""
        }`,
    ),
    ...unavailableSteps(preview).map((entry) =>
      entry.reasonKey
        ? `${
            entry.inner_step_id
              ? t("authority.issueInCall", { step: entry.inner_step_id, call: entry.step_id })
              : t("authority.issueStep", { step: entry.step_id })
          }: ${t(entry.reasonKey)}`
        : t("authority.issueUnavailable", { step: entry.step_id }),
    ),
  ];
}
