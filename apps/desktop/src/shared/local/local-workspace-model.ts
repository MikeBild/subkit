import { loopbackModelOrigin } from "@shared/local-model-server.ts";
import { localBundle, platformCapabilities } from "../platform-capabilities.ts";
import { normalizeServerAddress } from "../server-address.ts";
import type { BackupReason, SupervisorPhase } from "./supervisor-model.ts";

export const LOCAL_SETUP_STEPS = ["folder", "you", "ai", "setting"] as const;
export type LocalSetupStep = (typeof LOCAL_SETUP_STEPS)[number];
export const LAST_SETUP_STEP = LOCAL_SETUP_STEPS.length - 1;

export const SETUP_PHASES = ["database", "engine", "workspace"] as const;
export type SetupPhase = (typeof SETUP_PHASES)[number];

export type LocalErrorKind =
  | "port"
  | "disk"
  | "permission"
  | "folder"
  | "keyRejected"
  | "database"
  | "version"
  | "failed"
  | "restore"
  | "move";

export interface LocalProgress {
  database: boolean;
  engine: boolean;
  workspace: boolean;
}

export const NO_PROGRESS: LocalProgress = { database: false, engine: false, workspace: false };

export type PhaseState = "done" | "active" | "pending";

export interface PhaseRow {
  phase: SetupPhase;
  state: PhaseState;
}

const DATABASE_UP = new Set<SupervisorPhase>(["backing_up", "starting_engine", "running"]);

export function progressAfter(progress: LocalProgress, phase: SupervisorPhase): LocalProgress {
  if (phase === "preparing" || phase === "restarting")
    return { ...NO_PROGRESS, workspace: progress.workspace };
  return {
    database: progress.database || DATABASE_UP.has(phase),
    engine: progress.engine || phase === "running",
    workspace: progress.workspace,
  };
}

export function setupRows(progress: LocalProgress, working: boolean): PhaseRow[] {
  const firstOpen = SETUP_PHASES.findIndex((phase) => !progress[phase]);
  return SETUP_PHASES.map((phase, index) => ({
    phase,
    state: progress[phase] ? "done" : working && index === firstOpen ? "active" : "pending",
  }));
}

export function setupComplete(progress: LocalProgress): boolean {
  return SETUP_PHASES.every((phase) => progress[phase]);
}

const FAILURES: [RegExp, LocalErrorKind][] = [
  [/downgrade_refused|newer version|version mismatch/i, "version"],
  [/network_folder|cloud_synced_folder|relative_path/, "folder"],
  [/EADDRINUSE|address already in use|port \d+ is (in use|taken)/i, "port"],
  [/ENOSPC|no space left|disk is full|could not extend file/i, "disk"],
  [
    /EACCES|EPERM|EROFS|permission denied|operation not permitted|read-only file system/i,
    "permission",
  ],
  [/postgres|pg_ctl|pg_isready|initdb|database is not running/i, "database"],
];

export function classifyLocalFailure(reason: string): LocalErrorKind {
  return FAILURES.find(([pattern]) => pattern.test(reason))?.[1] ?? "failed";
}

export type AiAccessInput =
  | { kind: "provider"; provider: AiProvider; key: string }
  | { kind: "model"; origin: string };

export const AI_PROVIDERS = ["anthropic", "openai", "gemini"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const OWNER_NAME_MAX = 120;

export function ownerName(input: string): string | null {
  const name = input.trim();
  if (!name || name.length > OWNER_NAME_MAX || /\p{Cc}/u.test(name)) return null;
  return name;
}

export function parseFinishInput(raw: unknown): { name: string; ai: AiAccessInput | null } | null {
  const input = Object(raw) as { name?: unknown; ai?: unknown };
  const ai = Object(input.ai) as {
    kind?: unknown;
    provider?: unknown;
    key?: unknown;
    origin?: unknown;
  };
  const name = ownerName(String(input.name ?? ""));
  if (!name) return null;
  if (input.ai === null) return { name, ai: null };
  if (ai.kind === "provider") {
    const provider = AI_PROVIDERS.find((id) => id === ai.provider);
    const key = typeof ai.key === "string" ? ai.key.trim() : "";
    return provider && key && key.length <= 4096
      ? { name, ai: { kind: "provider", provider, key } }
      : null;
  }
  if (ai.kind !== "model") return null;
  const origin = loopbackModelOrigin(String(ai.origin));
  return origin ? { name, ai: { kind: "model", origin } } : null;
}

export interface BackupRow {
  name: string;
  at: number;
  reason: BackupReason;
  automatic: boolean;
  sizeBytes: number | null;
}

const BACKUP_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z-(update|manual|restore)$/;

export function parseBackupName(name: string): Omit<BackupRow, "sizeBytes"> | null {
  const match = BACKUP_NAME.exec(name);
  if (!match) return null;
  const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  if (Number.isNaN(at)) return null;
  const reason = match[5] as BackupReason;
  return { name, at, reason, automatic: reason !== "manual" };
}

export function backupRows(entries: { name: string; sizeBytes: number | null }[]): BackupRow[] {
  return entries
    .flatMap((entry) => {
      const parsed = parseBackupName(entry.name);
      return parsed ? [{ ...parsed, sizeBytes: entry.sizeBytes }] : [];
    })
    .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
}

export function megabytes(bytes: number | null): number | null {
  if (bytes === null || bytes < 0) return null;
  return bytes === 0 ? 0 : Math.max(1, Math.round(bytes / 1_000_000));
}

export function parseLowPowerMode(pmset: string): boolean {
  return /^\s*lowpowermode\s+1\s*$/m.test(pmset);
}

export interface PowerReport {
  on_battery: boolean;
  low_power_mode: boolean;
}

export interface LocalRuntimeInput {
  packaged: boolean;
  platform: string;
  arch: string;
  resourcesPath: string;
  repo: string;
  exists: (path: string) => boolean;
}

export interface LocalRuntime {
  postgresDir: string;
  engineCommand: string[];
}

export function localRuntime(input: LocalRuntimeInput): LocalRuntime | null {
  const bundle = localBundle(platformCapabilities(input.platform, input.arch));
  if (!bundle) return null;
  const compiled = `${input.repo}/dist/engine-desktop/${bundle.engine}`;
  const source = `${input.repo}/apps/engine/src/index.ts`;
  const engine = input.packaged
    ? `${input.resourcesPath}/local/engine`
    : input.exists(compiled)
      ? compiled
      : source;
  const postgresDir = input.packaged
    ? `${input.resourcesPath}/local/postgres`
    : `${input.repo}/apps/desktop/resources/postgres/${bundle.postgres}`;
  if (!input.exists(`${postgresDir}/bin/postgres`) || !input.exists(engine)) return null;
  return { postgresDir, engineCommand: engine === source ? ["bun", source] : [engine] };
}

export function powerChanged(previous: PowerReport | null, next: PowerReport): boolean {
  return (
    previous === null ||
    previous.on_battery !== next.on_battery ||
    previous.low_power_mode !== next.low_power_mode
  );
}

export function moveServerTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const address = normalizeServerAddress(raw);
  return address.ok ? address.origin : null;
}
