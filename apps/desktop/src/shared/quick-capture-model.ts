export const NOTE_MAX_CHARS = 20_000;
export const NOTE_TITLE_MAX = 60;

export type CapturePhase = "editing" | "sending" | "sent" | "failed";

export interface CaptureState {
  phase: CapturePhase;
  itemId: string | null;
}

export type CaptureEvent =
  | { type: "send" }
  | { type: "sent"; itemId: string }
  | { type: "failed" }
  | { type: "reset" };

export const INITIAL_CAPTURE: CaptureState = { phase: "editing", itemId: null };

export function reduceCapture(state: CaptureState, event: CaptureEvent): CaptureState {
  switch (event.type) {
    case "send":
      return state.phase === "sending" ? state : { phase: "sending", itemId: null };
    case "sent":
      return state.phase === "sending" ? { phase: "sent", itemId: event.itemId } : state;
    case "failed":
      return state.phase === "sending" ? { phase: "failed", itemId: null } : state;
    case "reset":
      return INITIAL_CAPTURE;
  }
}

export function canSend(text: string, phase: CapturePhase, online: boolean): boolean {
  const length = text.trim().length;
  return online && phase !== "sending" && length > 0 && length <= NOTE_MAX_CHARS;
}

export function noteTitle(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  const chars = [...line];
  return chars.length <= NOTE_TITLE_MAX ? line : `${chars.slice(0, NOTE_TITLE_MAX - 1).join("")}…`;
}

export interface IntakeNote {
  client_request_id: string;
  title: string;
  body: string;
  captured_at: string;
}

export function intakeNote(text: string, now: Date, requestId: string): IntakeNote | null {
  const body = text.trim();
  if (!body || body.length > NOTE_MAX_CHARS) return null;
  return {
    client_request_id: requestId,
    title: noteTitle(body),
    body,
    captured_at: now.toISOString(),
  };
}

export interface KeyNames {
  ctrl: string;
  space: string;
}

const MAC_KEYS: Readonly<Record<string, string>> = {
  Alt: "⌥",
  Option: "⌥",
  Control: "⌃",
  Ctrl: "⌃",
  Command: "⌘",
  Cmd: "⌘",
  CommandOrControl: "⌘",
  CmdOrCtrl: "⌘",
  Shift: "⇧",
};

function keyName(part: string, mac: boolean, names: KeyNames): string {
  if (part === "Space") return names.space;
  if (mac) return MAC_KEYS[part] ?? part;
  if (part === "Control" || part === "Ctrl" || part === "CommandOrControl" || part === "CmdOrCtrl")
    return names.ctrl;
  return part;
}

export function shortcutLabel(accelerator: string, platform: string, names: KeyNames): string {
  const mac = platform === "darwin";
  return accelerator
    .split("+")
    .map((part) => keyName(part, mac, names))
    .join(mac ? " " : " + ");
}

export function modifierLabel(platform: string, names: KeyNames): string {
  return platform === "darwin" ? "⌘" : names.ctrl;
}

export function intakeHref(itemId: string | null): string {
  return itemId ? `/intake/${encodeURIComponent(itemId)}` : "/intake";
}
