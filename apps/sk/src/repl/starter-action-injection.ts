// Digest-driven starter-action injection.
//
// When the startup health digest carries failures and the persona may run the
// triage action, the REPL prepends a "guided triage" entry keyed "1" and
// renumbers the persona defaults to "2".. — keeping the rendered list and the
// dispatch list (number-key handler) aligned. This logic lives here, shared by
// ink-app.tsx and its tests, so the two can never drift.

import type { OperatorHealthDigest } from "../engine-client.ts";
import type { PersonaProbe } from "../slash.ts";
import { type StarterAction, starterActionsForPersona } from "./starter-actions.tsx";
import {
  findTaskActionById,
  starterTaskActionsForPersona,
  type TaskAction,
} from "./task-actions.ts";

export const TRIAGE_ACTION_ID = "triage-digest-failures";

// Triage takes key "1"; the persona defaults shift to "2".. — capped at 8 so a
// single-char number key never collides (keys "2".."9"). Overflow entries are
// dropped rather than clamped onto a shared key.
const MAX_RENUMBERED_DEFAULTS = 8;

/** Whether to inject the guided-triage starter action: the digest must carry
 *  failures AND the persona must hold the triage action's required permission.
 *  Centralizes the RBAC gate so the render and dispatch lists agree. */
export function shouldInjectTriage(
  digest: OperatorHealthDigest | null | undefined,
  probe: PersonaProbe,
): boolean {
  if (!digest || digest.failure_groups.length === 0) return false;
  const action = findTaskActionById(TRIAGE_ACTION_ID);
  if (!action) return false;
  return !action.requires || probe.allows(action.requires);
}

function renumberDefaults<T extends { key?: string | undefined }>(actions: readonly T[]): T[] {
  return actions
    .slice(0, MAX_RENUMBERED_DEFAULTS)
    .map((action, i) => ({ ...action, key: String(i + 2) }));
}

/** Render list: persona starter actions, with the triage entry prepended at
 *  key "1" when `injectTriage`. */
export function buildStarterActions(
  personaLabel: string,
  opts: { injectTriage: boolean; digestFailCount: number },
): readonly StarterAction[] {
  const base = starterActionsForPersona(personaLabel);
  if (!opts.injectTriage) return base;
  const triage: StarterAction = {
    key: "1",
    label: `Fix ${opts.digestFailCount} failure${opts.digestFailCount === 1 ? "" : "s"}`,
    detail: "guided triage",
    actionId: TRIAGE_ACTION_ID,
  };
  return [triage, ...renumberDefaults(base)];
}

/** Dispatch list (drives the number-key handler): persona task actions, with
 *  the triage TaskAction prepended at key "1" when `injectTriage`. Mirrors
 *  buildStarterActions so render and dispatch keys stay aligned. */
export function buildStarterTaskActions(
  personaLabel: string,
  probe: PersonaProbe,
  opts: { injectTriage: boolean },
): readonly TaskAction[] {
  const base = starterTaskActionsForPersona(personaLabel, probe);
  if (!opts.injectTriage) return base;
  const triageAction = findTaskActionById(TRIAGE_ACTION_ID);
  if (!triageAction) return base;
  return [{ ...triageAction, key: "1" }, ...renumberDefaults(base)];
}
