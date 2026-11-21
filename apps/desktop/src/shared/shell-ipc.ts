import { parseAppUrl } from "./app-url.ts";
import type { BrowserSheet } from "./browser-sheet-model.ts";
import type { DropChoice, DropSheet } from "./drop-model.ts";
import type { Locale } from "./i18n.ts";
import type { CaptureState } from "./quick-capture-model.ts";
import type { ShellMessages } from "./shell-i18n.ts";

export type ShellView = "capture" | "drop" | "sheet";
export const SHELL_VIEWS: readonly ShellView[] = ["capture", "drop", "sheet"];

export const SHELL_PAGE = "shell.html";

export function shellUrl(view: ShellView): string {
  return `subkit-app://shell/${SHELL_PAGE}#${view}`;
}

export function isShellUrl(raw: string): boolean {
  return parseAppUrl(raw)?.pathname === `/${SHELL_PAGE}`;
}

export function shellViewOf(raw: string): ShellView | null {
  const url = parseAppUrl(raw);
  if (url?.pathname !== `/${SHELL_PAGE}`) return null;
  const view = url.hash.slice(1);
  return (SHELL_VIEWS as readonly string[]).includes(view) ? (view as ShellView) : null;
}

export const SHELL_CHANNELS = {
  getState: "shell:get-state",
  state: "shell:state",
  sendNote: "shell:send-note",
  place: "shell:place",
  close: "shell:close",
  reopenBrowser: "shell:reopen-browser",
} as const;

export interface ShellState {
  view: ShellView;
  locale: Locale;
  platform: string;
  dark: boolean;
  messages: ShellMessages;
  online: boolean;
  capture: CaptureState;
  drop: DropSheet | null;
  sheet: BrowserSheet | null;
}

export interface ShellBridge {
  getState(): Promise<ShellState | null>;
  onState(listener: (state: ShellState) => void): void;
  sendNote(text: string): Promise<void>;
  place(choice: DropChoice): Promise<void>;
  close(): Promise<void>;
  reopenBrowser(): Promise<void>;
}

export function isDropChoice(value: unknown): value is DropChoice {
  return value === "file" || value === "source" || value === "chat" || value === "inbox";
}
