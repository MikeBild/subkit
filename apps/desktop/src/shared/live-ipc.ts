import { parseAppUrl } from "./app-url.ts";
import type { Locale, Messages } from "./i18n.ts";
import type { LiveSnapshot } from "./local/live-view-model.ts";

export type LiveView = "window" | "overlay";
export const LIVE_VIEWS: readonly LiveView[] = ["window", "overlay"];

export const LIVE_PAGE = "live.html";
export const LIVE_SCREENSHOT = "screenshot.png";
export const STOP_ACCELERATOR = "CommandOrControl+Shift+Escape";

export function liveUrl(view: LiveView): string {
  return `subkit-app://shell/${LIVE_PAGE}#${view}`;
}

export function isLiveUrl(raw: string): boolean {
  return parseAppUrl(raw)?.pathname === `/${LIVE_PAGE}`;
}

export function liveViewOf(raw: string): LiveView | null {
  const url = parseAppUrl(raw);
  if (url?.pathname !== `/${LIVE_PAGE}`) return null;
  const view = url.hash.slice(1);
  return (LIVE_VIEWS as readonly string[]).includes(view) ? (view as LiveView) : null;
}

export function screenshotSrc(version: number): string | null {
  return version > 0 ? `${LIVE_SCREENSHOT}?v=${version}` : null;
}

export const LIVE_CHANNELS = {
  getState: "live:get-state",
  state: "live:state",
  stop: "live:stop",
  decide: "live:decide",
  handBack: "live:hand-back",
  close: "live:close",
} as const;

export interface LiveWindowState {
  view: LiveView;
  locale: Locale;
  dark: boolean;
  messages: Messages;
  live: LiveSnapshot;
}

export interface LiveBridge {
  getState(): Promise<LiveWindowState | null>;
  onState(listener: (state: LiveWindowState) => void): void;
  stop(): Promise<void>;
  decide(allow: boolean): Promise<void>;
  handBack(): Promise<void>;
  close(): Promise<void>;
}
