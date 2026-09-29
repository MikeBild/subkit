import type { TranslationKey } from "@/lib/i18n";
import type { AuthoringMode } from "./chat-permission";

// What each authoring mode lets through without asking, and what it still asks
// about — §14's gate matrix, mirrored from the engine's one enforcement table
// (`decideToolMode` in apps/engine/src/conversations/tool-policies.ts).
// chat-mode.test.ts calls that function with one probe call per row and fails
// the moment the two disagree.
//
// The picker used to offer "System default — autonomous preparation" beside
// "Autonomous preparation". The engine creates a conversation without a mode
// as `auto` (conversations/service/create.ts), so the two were one matrix under
// two names — the reading trap §14 names.

/** The modes a new conversation can start in, the engine's default first. */
export const AUTHORING_MODES: readonly AuthoringMode[] = ["auto", "ask", "plan"];

/** What a new conversation gets when nobody picks: the engine's own default. */
export const DEFAULT_AUTHORING_MODE: AuthoringMode = "auto";

export type GateRow =
  | "readAndCheck"
  | "webSearch"
  | "preparation"
  | "proposals"
  | "otherChanges"
  | "dangerous"
  | "inlineCredential"
  | "liveRuns";

/**
 * Per row and mode: does a person confirm the call before it runs?
 *
 * - Reading drafts and dry runs never ask.
 * - Web search asks under ask/plan (its own default) and runs under auto.
 * - Preparation — saving a new workflow draft, adding a knowledge source —
 *   runs without asking in `auto` only.
 * - Proposals a person approves later (a learning, a skill candidate) are
 *   pinned never-gate: the approval is the confirmation.
 * - Other workspace changes, dangerous calls (deleting, overwriting) and a
 *   credential pasted into the conversation ask in every mode.
 * - Running a workflow live asks in the conversation under ask/plan only.
 *   Under auto it does not ask here — admission decides (see `outside`).
 */
export const GATE_MATRIX: Readonly<Record<GateRow, Readonly<Record<AuthoringMode, boolean>>>> = {
  readAndCheck: { auto: false, ask: false, plan: false },
  webSearch: { auto: false, ask: true, plan: true },
  preparation: { auto: false, ask: true, plan: true },
  proposals: { auto: false, ask: false, plan: false },
  otherChanges: { auto: true, ask: true, plan: true },
  dangerous: { auto: true, ask: true, plan: true },
  inlineCredential: { auto: true, ask: true, plan: true },
  liveRuns: { auto: false, ask: true, plan: true },
};

const ROW_KEYS: Readonly<Record<GateRow, TranslationKey>> = {
  readAndCheck: "chat.mode.gate.readAndCheck",
  webSearch: "chat.mode.gate.webSearch",
  preparation: "chat.mode.gate.preparation",
  proposals: "chat.mode.gate.proposals",
  otherChanges: "chat.mode.gate.otherChanges",
  dangerous: "chat.mode.gate.dangerous",
  inlineCredential: "chat.mode.gate.inlineCredential",
  liveRuns: "chat.mode.gate.liveRuns",
};

export interface ModeGates {
  /** Rows a person confirms before they happen. */
  asks: TranslationKey[];
  /** Rows that run without asking. */
  free: TranslationKey[];
  /**
   * What no mode decides. A live run is admitted by a standing permission or
   * a fresh approval in every mode; under auto a run a standing permission
   * covers starts without a question in the conversation. Listing live runs
   * under "asks first" in every mode claimed a gate auto does not hold.
   */
  outside: TranslationKey[];
  /**
   * An instruction to the model rather than an enforced gate (§14 Leitplanke).
   * `plan` enforces exactly what `ask` enforces; what makes it "planning" is
   * that the model is told so — a request, not a limit.
   */
  guidance: TranslationKey | null;
}

export function modeGates(mode: AuthoringMode): ModeGates {
  const rows = Object.keys(GATE_MATRIX) as GateRow[];
  return {
    asks: rows.filter((row) => GATE_MATRIX[row][mode]).map((row) => ROW_KEYS[row]),
    free: rows.filter((row) => !GATE_MATRIX[row][mode]).map((row) => ROW_KEYS[row]),
    outside: ["chat.mode.gate.admission"],
    guidance: mode === "plan" ? "chat.mode.guidance.plan" : null,
  };
}

/**
 * A mode's short name: the pill in the header shows this and nothing else.
 * It is the option's accessible name too, so it never carries the default
 * marker or the explanation — those sit beside it in the open list.
 */
export function modeLabelKey(mode: AuthoringMode): TranslationKey {
  return `chat.mode.${mode}`;
}

/** What the open list says after the name: the default one says it is the default. */
export function modeSuffixKey(mode: AuthoringMode): TranslationKey | null {
  return mode === DEFAULT_AUTHORING_MODE ? "chat.mode.systemDefault" : null;
}

/** One line per option in the open list: what picking it changes. */
export function modeDescriptionKey(mode: AuthoringMode): TranslationKey {
  return `chat.mode.description.${mode}`;
}
