// Digest-driven starter-action injection.
//
// When the startup health digest carries failures and the persona may run the
// triage action, the REPL prepends a "guided triage" entry keyed "1" and
// renumbers the persona defaults to "2".. — keeping the rendered list and the
// dispatch list (number-key handler) aligned. This logic lives here, shared by
// ink-app.tsx and its tests, so the two can never drift.

import type { OperatorHealthDigest } from "../engine-client.ts";
import { totalFailureCount } from "../lib/operator-digest.ts";
import type { PersonaProbe } from "../slash.ts";
import { type StarterAction, starterActionsForPersona } from "./starter-actions.tsx";
import {
  findTaskActionById,
  starterTaskActionsForPersona,
  type TaskAction,
} from "./task-actions.ts";

export const TRIAGE_ACTION_ID = "triage-digest-failures";

// Triage takes key "1"; the persona defaults shift to "2".. — capped so a
// single-char number key never collides (keys "2".."9"). Overflow entries are
// dropped rather than clamped onto a shared key. Today's persona defaults have
// 5 entries, so this never trips; the cap is a defensive invariant.
const MAX_RENUMBERED_DEFAULTS = 8;

/** Whether to inject the guided-triage starter action: the digest must carry
 *  failures AND the persona must hold the triage action's required permission.
 *  The single RBAC + failure gate — render and dispatch both derive from it. */
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

/** Render list: persona starter actions (RBAC-filtered by `probe`), with the
 *  triage entry prepended at key "1" when the digest + permission warrant it.
 *  The injection decision is derived internally via shouldInjectTriage so it
 *  can never be passed in inconsistently with the probe. */
export function buildStarterActions(
  personaLabel: string,
  probe: PersonaProbe,
  digest: OperatorHealthDigest | null | undefined,
): readonly StarterAction[] {
  const base = starterActionsForPersona(personaLabel, probe);
  if (!shouldInjectTriage(digest, probe)) return base;
  const failCount = digest ? totalFailureCount(digest) : 0;
  const triage: StarterAction = {
    key: "1",
    label: `Fix ${failCount} failure${failCount === 1 ? "" : "s"}`,
    detail: "guided triage",
    actionId: TRIAGE_ACTION_ID,
  };
  return [triage, ...renumberDefaults(base)];
}

/** Dispatch list (drives the number-key handler): persona task actions, with
 *  the triage TaskAction prepended at key "1" under the same gate. Mirrors
 *  buildStarterActions so render and dispatch keys stay aligned. */
export function buildStarterTaskActions(
  personaLabel: string,
  probe: PersonaProbe,
  digest: OperatorHealthDigest | null | undefined,
): readonly TaskAction[] {
  const base = starterTaskActionsForPersona(personaLabel, probe);
  if (!shouldInjectTriage(digest, probe)) return base;
  const triageAction = findTaskActionById(TRIAGE_ACTION_ID);
  if (!triageAction) return base;
  return [{ ...triageAction, key: "1" }, ...renumberDefaults(base)];
}
