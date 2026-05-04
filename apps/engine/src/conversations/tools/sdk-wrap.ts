// Public registry: build the SDK `toolSet` for one `runLoop` invocation.
//
// After the Phase 4 split (audit §4.2), the wrapping logic lives in
// `sdk-wrap/`:
//
//   - `sdk-wrap/state.ts`          — TurnSignals, WrappedToolOutput,
//                                    constants, computeValidationFingerprint
//   - `sdk-wrap/policy-helpers.ts` — confirmation / dedupe / risk helpers
//   - `sdk-wrap/invoke.ts`         — wrapOne (per-tool wrapper)
//
// External callers continue to import `wrapTools`, `TurnSignals`,
// `MAX_CONSECUTIVE_FAILURES`, and `computeValidationFingerprint` from
// this file; nothing else escapes the module boundary.

import type { Tool } from "ai";
import type { Db } from "../../db/client.ts";
import type { PermissionMode, ToolPolicies } from "../tool-policies.ts";
import type { TurnEvent } from "../types.ts";
import { filterByAuthoringPalette } from "./authoring-palette.ts";
import { filterBySkillGate } from "./gated.ts";
import { listTools, type ToolContext } from "./index.ts";
import { wrapOne } from "./sdk-wrap/invoke.ts";
import type { TurnSignals, WrappedToolOutput } from "./sdk-wrap/state.ts";

export {
  computeValidationFingerprint,
  MAX_CONSECUTIVE_FAILURES,
  MAX_TURN_LOOP_WARNINGS,
  MAX_VALIDATION_FINGERPRINT_REPEAT,
  type TurnSignals,
  type WrappedToolOutput,
} from "./sdk-wrap/state.ts";

/**
 * Build the SDK `toolSet` for one `runLoop` invocation. Each wrapped
 * tool closes over `ctx`, `signals`, and `events` so side effects land
 * in the same sink the loop returns to callers.
 */
export function wrapTools(
  ctx: ToolContext,
  signals: TurnSignals,
  events: TurnEvent[],
  db: Db,
  loadedSkills: ReadonlyArray<string> = [],
  toolPolicies: ToolPolicies = {},
  permissionMode: PermissionMode | null = null,
): Record<string, Tool<Record<string, unknown>, WrappedToolOutput>> {
  const out: Record<string, Tool<Record<string, unknown>, WrappedToolOutput>> = {};
  // Apply skill-gate: tools whose `requires_skill` isn't in loadedSkills
  // are hidden from the model until the matching `load_skill` call.
  const loadedSkillSet = new Set(loadedSkills);
  const visibleTools = filterByAuthoringPalette(
    filterBySkillGate(listTools(), loadedSkills),
    ctx.getDraft(),
    loadedSkillSet,
  );
  for (const t of visibleTools) {
    out[t.name] = wrapOne(t, ctx, signals, events, db, toolPolicies, permissionMode, loadedSkills);
  }
  return out;
}
