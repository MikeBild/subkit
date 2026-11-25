import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { formatBytes } from "@shared/file-kinds.ts";
import { formatLimitDuration, type StepLimit, stepLimitOf } from "@shared/step-limit.ts";
import { heldReasonLine } from "./held-reason.ts";

type ExecutionOutcome = components["schemas"]["ExecutionOutcome"];

export function executionOutcomeLine(outcome: ExecutionOutcome | null): string | null {
  if (!outcome) return null;
  const parts: string[] = [outcome.kind];
  if (outcome.kind === "held") parts.push("— writes held, nothing written");
  if (outcome.failed_step) {
    parts.push(`at step ${outcome.failed_step.step_key} (${outcome.failed_step.kind})`);
  }
  const cause = [
    outcome.cause_class,
    outcome.status_class ? `upstream ${outcome.status_class}` : null,
    outcome.error_code,
    outcome.refusal_reason,
  ]
    .filter(Boolean)
    .join(", ");
  if (cause) parts.push(`· ${cause}`);
  const s = outcome.steps;
  parts.push(
    `· steps ${s.succeeded}/${s.total} ok` +
      (s.failed ? `, ${s.failed} failed` : "") +
      (s.held ? `, ${s.held} held` : "") +
      (s.skipped ? `, ${s.skipped} skipped` : ""),
  );
  if (outcome.output_contract !== "none")
    parts.push(`· output contract ${outcome.output_contract}`);
  const held = heldReasonLine(outcome.error_code);
  if (held) parts.push(`— ${held}`);
  return parts.join(" ");
}

function limitPhrase(limit: StepLimit): string {
  switch (limit.kind) {
    case "time":
      return limit.ceiling
        ? `stopped after ${formatLimitDuration(limit.ms, "en-US")}, the operator ceiling for transform steps; an operator can raise sandbox.max_transform_wall_ms`
        : `stopped after its ${formatLimitDuration(limit.ms, "en-US")} limit; raise timeout_ms on this step in the workflow`;
    case "pages":
      return `stopped at its limit of ${limit.count} pages; raise max_pages in the step’s pagination`;
    case "items":
      return `stopped at its limit of ${limit.count} items; raise max_items in the step’s pagination`;
    case "response":
      return `stopped because the response passed its ${formatBytes(limit.bytes, "en-US")} size limit; raise max_response_bytes in the connector’s settings`;
    case "memory":
      return `stopped at the ${formatBytes(limit.bytes, "en-US")} memory limit for paged results; narrow the request or set a lower max_items`;
  }
}

export function stepLimitLine(step: { step_key: string; error?: unknown }): string | null {
  const limit = stepLimitOf(step.error);
  return limit ? `step ${step.step_key} ${limitPhrase(limit)}` : null;
}

type ExecutionRecordLink = components["schemas"]["ExecutionRecordLink"];

export function recordLinkLines(links: readonly ExecutionRecordLink[] | undefined): string[] {
  return (links ?? []).map((link) =>
    [link.connector_name, link.label, link.url].filter(Boolean).join(" · "),
  );
}

type SensitiveRequestMeta = components["schemas"]["SensitiveRequestMeta"];

function sensitiveMetaOf(meta: unknown): SensitiveRequestMeta | null {
  return meta && typeof meta === "object" && (meta as { driver?: unknown }).driver === "sensitive"
    ? (meta as SensitiveRequestMeta)
    : null;
}

export function sensitiveDiagnosticsLine(step: { request_meta?: unknown }): string | null {
  const meta = sensitiveMetaOf(step.request_meta);
  if (!meta) return null;
  const placeholders = Object.entries(meta.placeholder_types ?? {}).map(
    ([path, type]) => `${path}: ${type}`,
  );
  const parts = [
    meta.status_class ? `upstream ${meta.status_class}` : null,
    meta.body_size ? `body ${meta.body_size}` : null,
    placeholders.length > 0 ? `placeholders ${placeholders.join(", ")}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `protected run · ${parts.join(" · ")}` : null;
}
