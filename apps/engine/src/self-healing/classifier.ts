import type { TemplateCapabilities } from "../connectors/templates.ts";
import type { PatchProposal } from "../llm/flows/repair.ts";
import { log } from "../logging/logger.ts";
import type { DriftSignal, PatchDecision } from "./types.ts";

export interface RateLimitPatchCandidate {
  kind: "rate_limited";
  recommended_action: "retry_with_backoff";
  recommended_backoff_ms: number;
}

export function classifyRateLimitFromTemplate(
  capabilities: TemplateCapabilities | null | undefined,
  httpStatus: number,
): RateLimitPatchCandidate | null {
  if (httpStatus !== 429 && httpStatus !== 503) return null;
  if (!capabilities?.rate_limits) return null;
  return {
    kind: "rate_limited",
    recommended_action: "retry_with_backoff",
    recommended_backoff_ms: capabilities.rate_limits.recommended_backoff_ms,
  };
}

const SAFE_KINDS = new Set<PatchProposal["kind"]>([
  "update_field_path",
  "rename_param",
  "add_header",
  "change_type",
  "rate_limited",
]);

function _classify(proposal: PatchProposal, signal: DriftSignal | null): PatchDecision {
  const reasons: string[] = [];
  if (proposal.classification === "unsafe") {
    reasons.push("proposal.classification=unsafe");
    return { classification: "unsafe", reasons };
  }
  if (!SAFE_KINDS.has(proposal.kind)) {
    reasons.push(`proposal.kind=${proposal.kind} is outside the safe palette`);
    return { classification: "unsafe", reasons };
  }
  const patch = proposal.patch ?? {};
  const patchAny = patch as Record<string, unknown>;
  if (typeof patchAny.method === "string") {
    reasons.push("patch touches HTTP method");
    return { classification: "unsafe", reasons };
  }
  if (patchAny.auth_type !== undefined || patchAny.credential_mode !== undefined) {
    reasons.push("patch touches auth scheme");
    return { classification: "unsafe", reasons };
  }
  if (Array.isArray(patchAny.required_removed) && patchAny.required_removed.length > 0) {
    reasons.push("patch removes required fields");
    return { classification: "unsafe", reasons };
  }
  if (patchAny.status_semantics_change === true) {
    reasons.push("patch alters status-code semantics");
    return { classification: "unsafe", reasons };
  }
  if (patchAny.url_change_beyond_path === true) {
    reasons.push("patch changes destination URL beyond path segments");
    return { classification: "unsafe", reasons };
  }
  if (patchAny.format_flip === true) {
    reasons.push("patch flips request/response encoding format");
    return { classification: "unsafe", reasons };
  }
  if (signal && signal.kind === "schema_diff" && signal.removed.length > 0) {
    reasons.push(`drift removes keys: ${signal.removed.join(",")}`);
    return { classification: "unsafe", reasons };
  }
  if (signal && signal.kind === "stdlib_version_drift") {
    reasons.push(
      `stdlib drift: recorded major ${signal.recorded_major}, current major ${signal.current_major}`,
    );
    return { classification: "unsafe", reasons };
  }
  if (signal && signal.kind === "validation_failed") {
    reasons.push(`validation_failed: invariant '${signal.expression}' did not hold`);
    return { classification: "unsafe", reasons };
  }
  if (signal && signal.kind === "endpoint_contract") {
    reasons.push(
      `endpoint_contract: vendor ${signal.severity === "removed" ? "removed" : "deprecated"} ${signal.request.path ?? signal.request.url ?? "the endpoint"}`,
    );
    return { classification: "unsafe", reasons };
  }
  reasons.push("rename/widening/optional-only patch");
  return { classification: "safe", reasons };
}

export function classifyPatch(proposal: PatchProposal, signal: DriftSignal | null): PatchDecision {
  const decision = _classify(proposal, signal);
  log.selfHealing.patch.classified({
    patch_kind: proposal.kind,
    classification: decision.classification,
    reasons: decision.reasons,
  });
  return decision;
}
