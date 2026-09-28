import type { TranslationKey } from "@/lib/i18n";
import type { AuthoringMode } from "./chat-permission";

// What each authoring mode lets through without asking, and what it still asks
// about — §14's gate matrix, read off the engine's one enforcement table
// (`decideToolMode` in apps/engine/src/conversations/tool-policies.ts).
//
// The picker used to offer "System default — autonomous preparation" beside
// "Autonomous preparation". The engine creates a conversation without a mode
// as `auto` (conversations/service/create.ts), so the two were one matrix under
// two names — the reading trap §14 names. There is one entry now, marked as the
// default, and every entry says which gates remain.

/** The modes a new conversation can start in, the engine's default first. */
export const AUTHORING_MODES: readonly AuthoringMode[] = ["auto", "ask", "plan"];

/** What a new conversation gets when nobody picks: the engine's own default. */
export const DEFAULT_AUTHORING_MODE: AuthoringMode = "auto";

export type GateRow =
  | "readAndCheck"
  | "preparation"
  | "proposals"
  | "otherChanges"
  | "dangerous"
  | "inlineCredential"
  | "activateAndRun";

/**
 * One row per kind of call, and per mode whether a person confirms it first.
 *
 * - Reading and checking never asks.
 * - Preparation — saving a workflow draft, adding a knowledge source — runs
 *   without asking in `auto` only (`AUTO_PREPARATION_WRITES`).
 * - Proposals a person approves later (a learning, a skill candidate) are
 *   pinned never-gate: the approval is the confirmation.
 * - Every other change to the workspace asks in all three modes: `auto` gates
 *   unclassified tenant writes, `ask`/`plan` gate every tenant write.
 * - Dangerous calls (deleting, writing to an outside system) and a credential
 *   pasted into the conversation ask in every mode.
 * - Activating a workflow and running it live need their own approval,
 *   outside the conversation, whatever the mode.
 */
const MATRIX: Readonly<Record<GateRow, Readonly<Record<AuthoringMode, boolean>>>> = {
  readAndCheck: { auto: false, ask: false, plan: false },
  preparation: { auto: false, ask: true, plan: true },
  // Pinned `neverGate` (save_learning, create_skill): an inert proposal whose
  // approval IS the confirmation, so no mode asks before filing it.
  proposals: { auto: false, ask: false, plan: false },
  otherChanges: { auto: true, ask: true, plan: true },
  dangerous: { auto: true, ask: true, plan: true },
  inlineCredential: { auto: true, ask: true, plan: true },
  activateAndRun: { auto: true, ask: true, plan: true },
};

const ROW_KEYS: Readonly<Record<GateRow, TranslationKey>> = {
  readAndCheck: "chat.mode.gate.readAndCheck",
  preparation: "chat.mode.gate.preparation",
  proposals: "chat.mode.gate.proposals",
  otherChanges: "chat.mode.gate.otherChanges",
  dangerous: "chat.mode.gate.dangerous",
  inlineCredential: "chat.mode.gate.inlineCredential",
  activateAndRun: "chat.mode.gate.activateAndRun",
};

export interface ModeGates {
  /** Rows a person confirms before they happen. */
  asks: TranslationKey[];
  /** Rows that run without asking. */
  free: TranslationKey[];
  /**
   * An instruction to the model rather than an enforced gate (§14 Leitplanke).
   * `plan` enforces exactly what `ask` enforces; what makes it "planning" is
   * that the model is told so — a request, not a limit.
   */
  guidance: TranslationKey | null;
}

export function modeGates(mode: AuthoringMode): ModeGates {
  const rows = Object.keys(MATRIX) as GateRow[];
  return {
    asks: rows.filter((row) => MATRIX[row][mode]).map((row) => ROW_KEYS[row]),
    free: rows.filter((row) => !MATRIX[row][mode]).map((row) => ROW_KEYS[row]),
    guidance: mode === "plan" ? "chat.mode.guidance.plan" : null,
  };
}

/** The picker's label for a mode — the default one says it is the default. */
export function modeLabelKey(mode: AuthoringMode): TranslationKey {
  return mode === DEFAULT_AUTHORING_MODE ? "chat.mode.default" : `chat.mode.${mode}`;
}
