// Build-time author permission warnings (Stream 4).
//
// Connector READ is already enforced at resolution time (the placeholder
// resolver calls `can(connector:read)` when a step resolves `${cred.*}` /
// `${connector.*}`). This adds a purely-additive authoring-time signal: warn
// the author EARLY when a write step targets a connector they cannot write,
// instead of letting it fail at run time.
//
// Best-effort and statically-scoped:
//   - only request steps that NAME a `connector_id` are checked (inline
//     url/headers steps bind no connector — we never infer one from a URL);
//   - mutation is one bit (read vs write), reusing `classifyRequestStepSideEffects`;
//     there is no read/write/delete distinction here.
//
// These produce non-blocking warnings (`code: author_missing_permission`)
// that ride the dry-run `warnings` array — never a hard gate error.

import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { classifyRequestStepSideEffects } from "../../execution/steps/request/side-effects.ts";
import { type ConnectorAccessLevel, connectorAccessLevel } from "../../rbac/evaluator.ts";
import type { RequestStep } from "../../workflows/types.ts";

export interface BuildWarning {
  step_key: string | null;
  code: string;
  message: string;
}

export async function authorConnectorWriteWarnings(
  db: Db,
  author: ResolvedPrincipal,
  tenantId: string,
  steps: ReadonlyArray<Record<string, unknown>>,
): Promise<BuildWarning[]> {
  const warnings: BuildWarning[] = [];
  // One level lookup per connector, reused across steps.
  const levelCache = new Map<string, ConnectorAccessLevel>();

  for (const step of steps) {
    if (step.kind !== "request") continue;
    const connectorId = typeof step.connector_id === "string" ? step.connector_id : null;
    if (!connectorId) continue;
    if (classifyRequestStepSideEffects(step as unknown as RequestStep) !== "write") continue;

    let level = levelCache.get(connectorId);
    if (level === undefined) {
      level = await connectorAccessLevel(db, author, connectorId, tenantId);
      levelCache.set(connectorId, level);
    }
    if (level === "read-write") continue;

    const stepKey = typeof step.id === "string" ? step.id : null;
    const have = level === "read-only" ? "read-only" : "no";
    warnings.push({
      step_key: stepKey,
      code: "author_missing_permission",
      message:
        `you have ${have} access to connector ${connectorId}; step ` +
        `${stepKey ?? "?"} performs a write that needs read-write — request a grant ` +
        `or a key with that access before running this workflow`,
    });
  }
  return warnings;
}
