import type { TranslationKey } from "@/lib/i18n";
import type { AuthoringMode } from "./chat-permission";

export const AUTHORING_MODES: readonly AuthoringMode[] = ["auto", "ask", "plan"];

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

interface ModeGates {
  asks: TranslationKey[];
  free: TranslationKey[];
  outside: TranslationKey[];
  guidance: TranslationKey | null;
}

const ASKED_ROW_KEYS: Readonly<Partial<Record<GateRow, TranslationKey>>> = {
  liveRuns: "chat.mode.gate.liveRunsUncovered",
};

export function modeGates(mode: AuthoringMode): ModeGates {
  const rows = Object.keys(GATE_MATRIX) as GateRow[];
  return {
    asks: rows
      .filter((row) => GATE_MATRIX[row][mode])
      .map((row) => ASKED_ROW_KEYS[row] ?? ROW_KEYS[row]),
    free: rows.filter((row) => !GATE_MATRIX[row][mode]).map((row) => ROW_KEYS[row]),
    outside: ["chat.mode.gate.admission"],
    guidance: mode === "plan" ? "chat.mode.guidance.plan" : null,
  };
}

export function modeLabelKey(mode: AuthoringMode): TranslationKey {
  return `chat.mode.${mode}`;
}

export function modeSuffixKey(mode: AuthoringMode): TranslationKey | null {
  return mode === DEFAULT_AUTHORING_MODE ? "chat.mode.systemDefault" : null;
}

export function modeDescriptionKey(mode: AuthoringMode): TranslationKey {
  return `chat.mode.description.${mode}`;
}
