import type { MessageKey } from "./i18n.ts";

export type UpdateFailure = "check" | "download" | "unverified";

export type UpdateState =
  | { phase: "disabled" }
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "current" }
  | { phase: "available"; version: string }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "ready"; version: string }
  | { phase: "failed"; reason: UpdateFailure };

export type UpdateEvent =
  | { type: "checking" }
  | { type: "not-available" }
  | { type: "available"; version: string }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; message: string };

export function initialUpdateState(enabled: boolean): UpdateState {
  return enabled ? { phase: "idle" } : { phase: "disabled" };
}

const UNVERIFIED =
  /signature|not signed|code object is not signed|sha512|checksum|publisher|integrity/i;

export function updateFailure(state: UpdateState, message: string): UpdateFailure {
  if (UNVERIFIED.test(message)) return "unverified";
  return state.phase === "available" || state.phase === "downloading" ? "download" : "check";
}

function percentOf(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;
}

export function reduceUpdate(state: UpdateState, event: UpdateEvent): UpdateState {
  if (state.phase === "disabled") return state;
  if (state.phase === "ready" && event.type !== "downloaded") return state;
  switch (event.type) {
    case "checking":
      return state.phase === "available" || state.phase === "downloading"
        ? state
        : { phase: "checking" };
    case "not-available":
      return { phase: "current" };
    case "available":
      return { phase: "available", version: event.version };
    case "progress":
      return state.phase === "available" || state.phase === "downloading"
        ? { phase: "downloading", version: state.version, percent: percentOf(event.percent) }
        : state;
    case "downloaded":
      return { phase: "ready", version: event.version };
    case "error":
      return { phase: "failed", reason: updateFailure(state, event.message) };
  }
}

export function updateBusy(state: UpdateState): boolean {
  return state.phase === "checking" || state.phase === "available" || state.phase === "downloading";
}

export type UpdateAction = "check" | "restart" | null;

export function updateAction(state: UpdateState): UpdateAction {
  if (state.phase === "disabled" || updateBusy(state)) return null;
  return state.phase === "ready" ? "restart" : "check";
}

export interface UpdateText {
  key: MessageKey;
  vars: Record<string, string | number>;
}

export function updateStatus(state: UpdateState, appVersion: string): UpdateText {
  switch (state.phase) {
    case "disabled":
      return { key: "updates.disabled", vars: {} };
    case "idle":
      return { key: "updates.state.idle", vars: { version: appVersion } };
    case "checking":
      return { key: "updates.state.checking", vars: {} };
    case "current":
      return { key: "updates.state.current", vars: { version: appVersion } };
    case "available":
      return { key: "updates.state.available", vars: { version: state.version } };
    case "downloading":
      return {
        key: "updates.state.downloading",
        vars: { version: state.version, percent: state.percent },
      };
    case "ready":
      return { key: "updates.state.ready", vars: { version: state.version } };
    case "failed":
      return { key: `updates.state.failed.${state.reason}`, vars: {} };
  }
}

export function updateMenuLabel(state: UpdateState): UpdateText {
  if (state.phase === "checking") return { key: "updates.state.checking", vars: {} };
  if (state.phase === "available" || state.phase === "downloading")
    return {
      key: "updates.menu.downloading",
      vars: { percent: state.phase === "downloading" ? state.percent : 0 },
    };
  if (state.phase === "ready") return { key: "updates.menu.restart", vars: {} };
  return { key: "tray.checkUpdates", vars: {} };
}

export function updateFeedProblem(builderConfig: string): string | null {
  const publish = /^publish:[ \t]*(.*)$/m.exec(builderConfig);
  if (!publish) return "electron-builder.yml has no publish entry";
  if (
    /^(null|~|false)?$/.test((publish[1] ?? "").trim()) &&
    !/^publish:[ \t]*\n[ \t]+\S/m.test(builderConfig)
  )
    return "electron-builder.yml names no update feed under publish";
  const block = builderConfig.slice(publish.index);
  const insecure = /^[ \t]+(?:-[ \t]+)?url:[ \t]*["']?(?!https:\/\/)\S+/m.exec(block);
  return insecure ? "the update feed must be an https address" : null;
}

export type BuildPlatform = "darwin" | "win32" | "linux";

function filled(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function buildSigned(platform: string, env: Record<string, string | undefined>): boolean {
  if (platform === "darwin") return filled(env.CSC_LINK);
  if (platform === "win32")
    return (
      filled(env.WIN_CSC_LINK) || filled(env.CSC_LINK) || env.SUBKIT_DESKTOP_WIN_SIGNING === "cloud"
    );
  if (platform === "linux") return env.SUBKIT_DESKTOP_SIGNED_RELEASE === "1";
  return false;
}

export interface BuildUpdatesInput {
  flag: string | undefined;
  production: boolean;
  signed: boolean;
  feedProblem: string | null;
}

export interface BuildUpdatesDecision {
  enabled: boolean;
  error: string | null;
}

export function buildUpdates(input: BuildUpdatesInput): BuildUpdatesDecision {
  const flag = (input.flag ?? "").trim();
  if (flag !== "" && flag !== "0" && flag !== "1")
    return { enabled: false, error: "SUBKIT_DESKTOP_UPDATES must be 0, 1 or unset" };
  if (flag === "0") return { enabled: false, error: null };
  const enabled = input.production && input.signed && input.feedProblem === null;
  if (flag !== "1" || enabled) return { enabled, error: null };
  if (!input.production)
    return { enabled: false, error: "Updates are only built into a production build" };
  if (input.feedProblem)
    return {
      enabled: false,
      error: `SUBKIT_DESKTOP_UPDATES=1 needs an update feed: ${input.feedProblem}`,
    };
  return {
    enabled: false,
    error: "SUBKIT_DESKTOP_UPDATES=1 needs a signed build: no signing identity is configured",
  };
}
