import type { MessageKey } from "./i18n.ts";
import { classifyLocalFailure } from "./local/local-workspace-model.ts";

export const STARTUP_PHASES = ["app", "window", "database", "engine", "runner"] as const;
export type StartupPhase = (typeof STARTUP_PHASES)[number];

export type StartupFailureKind =
  | "port"
  | "database"
  | "engine"
  | "version"
  | "disk"
  | "permission"
  | "folder"
  | "window"
  | "app";

export interface StartupFailure {
  kind: StartupFailureKind;
  phase: StartupPhase;
  title: MessageKey;
  next: MessageKey;
  reason: string;
}

const LOCAL_KINDS: ReadonlySet<string> = new Set([
  "port",
  "database",
  "version",
  "disk",
  "permission",
  "folder",
]);

function kindFor(phase: StartupPhase, reason: string): StartupFailureKind {
  const local = classifyLocalFailure(reason);
  if (LOCAL_KINDS.has(local)) return local as StartupFailureKind;
  if (phase === "database") return "database";
  if (phase === "engine" || phase === "runner" || /\bengine\b/i.test(reason)) return "engine";
  if (phase === "window") return "window";
  return "app";
}

const COPY: Record<StartupFailureKind, { title: MessageKey; next: MessageKey }> = {
  port: { title: "startup.port.title", next: "startup.port.next" },
  database: { title: "startup.database.title", next: "startup.database.next" },
  engine: { title: "startup.engine.title", next: "startup.engine.next" },
  version: { title: "startup.version.title", next: "startup.version.next" },
  disk: { title: "startup.disk.title", next: "startup.disk.next" },
  permission: { title: "startup.permission.title", next: "startup.permission.next" },
  folder: { title: "startup.folder.title", next: "startup.folder.next" },
  window: { title: "startup.window.title", next: "startup.window.next" },
  app: { title: "startup.app.title", next: "startup.app.next" },
};

export function classifyStartupFailure(phase: StartupPhase, reason: string): StartupFailure {
  const kind = kindFor(phase, reason);
  return { kind, phase, ...COPY[kind], reason };
}

export const STARTUP_ACTIONS = ["copy", "logs", "quit"] as const;
export type StartupAction = (typeof STARTUP_ACTIONS)[number];

export function startupActionAt(index: number): StartupAction {
  return STARTUP_ACTIONS[index] ?? "quit";
}
