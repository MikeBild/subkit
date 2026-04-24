// Patch classifier.
//
// A small pure function that inspects a `PatchProposal` and returns a
// `PatchDecision`. The rule is conservative by design: anything the
// classifier cannot prove `safe` lands as `unsafe` so human review
// catches it.
//
// The classifier deliberately never calls the LLM a second time. It
// reads the structured patch object the repair flow produced plus the
// drift signal that triggered the repair and makes a one-shot
// decision.

import type { TemplateCapabilities } from "../connectors/templates.ts";
import type { PatchProposal } from "../llm/flows/repair.ts";
import { log } from "../logging/logger.ts";
import type { DriftSignal, PatchDecision } from "./types.ts";

export interface RateLimitPatchCandidate {
  kind: "rate_limited";
  recommended_action: "retry_with_backoff";
  recommended_backoff_ms: number;
}

/**
 * When an execution step receives a 429 or 503 and the connector's template
 * capabilities include rate_limits, classify the failure as `rate_limited`
 * and surface a `retry_with_backoff` patch candidate with the template's
 * recommended_backoff_ms. Returns null when the status is not 429/503 or
 * the connector carries no rate_limit hint.
 *
 * The connector's `config.capabilities` is typed as `unknown` at the
 * call-site; callers should cast to `TemplateCapabilities | null` when
 * reading from connector.config.
 */
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
  // rate_limited patches are considered safe by default — they only adjust
  // the step's retry/backoff metadata to honour an upstream 429/503 hint,
  // they do not change URLs, auth, or payload shapes. The narrower checks
  // below still guard against the LLM trying to smuggle unsafe fields into
  // a patch under the `rate_limited` label.
  "rate_limited",
]);

/**
 * Rules per docs/06-execution.md §Patch classification:
 *
 *   safe: field renames, compatible type widenings (string → string
 *         | null, int → number), new optional headers, added optional
 *         response fields.
 *   unsafe: HTTP method change, auth scheme change, required-field
 *           removal, status-code semantics change, destination URL
 *           change beyond path segments, format flips.
 *
 * In addition, the classifier respects the LLM's own self-flag. If
 * the proposal already ships with `classification: "unsafe"` we
 * propagate that — we never *soften* the model's call.
 */
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
    // Stdlib major-version drift is never safe to auto-apply: a major
    // bump implies the author needs to re-check hook/transform
    // semantics against the new surface. The patch-candidate record
    // exists purely for operator review.
    reasons.push(
      `stdlib drift: recorded major ${signal.recorded_major}, current major ${signal.current_major}`,
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
