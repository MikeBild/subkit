import { LOCAL_READY_EVENT } from "@shared/device/local-launch.ts";
import { segmentsUnder } from "@shared/local-policy/paths.ts";
import type { RestartPlan } from "./restart-policy.ts";

export const LOCAL_DATABASE = "postgres";
export const LOCAL_DATABASE_USER = "subkit";
export const POSTGRES_SOCKET_PORT = 5432;
export const SOCKET_PATH_MAX_BYTES = 103;
export const BACKUPS_KEPT = 3;

export interface LocalLayout {
  root: string;
  pgdata: string;
  files: string;
  backups: string;
  logs: string;
  state: string;
}

function joinPath(separator: string, ...parts: string[]): string {
  return parts
    .map((part, index) =>
      index === 0 ? part.replace(/[\\/]+$/, "") : part.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .join(separator);
}

export function localLayout(appData: string, workspace: string, separator = "/"): LocalLayout {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workspace))
    throw new Error(`workspace folder name "${workspace}" is not allowed`);
  const root = joinPath(separator, appData, "local", workspace);
  return {
    root,
    pgdata: joinPath(separator, root, "pgdata"),
    files: joinPath(separator, root, "files"),
    backups: joinPath(separator, root, "backups"),
    logs: joinPath(separator, root, "logs"),
    state: joinPath(separator, root, "local-engine.json"),
  };
}

export interface MountEntry {
  mountPoint: string;
  type: string;
}

const MAC_SYNCED =
  /^(Library\/Mobile Documents|Library\/CloudStorage|Dropbox(?: \([^/]*\))?|Google Drive|Box|OneDrive[^/]*|iCloud Drive[^/]*)(\/|$)/;
const WINDOWS_SYNCED = /^(onedrive[^\\]*|dropbox|google drive|icloud ?drive|box)(\\|$)/;
const NETWORK_FILESYSTEMS = new Set(["smbfs", "nfs", "afpfs", "webdav", "cifs", "ftp", "9p"]);
const FUSE_FILESYSTEM = /fuse/i;
const MOUNT_PATHS = { os: "darwin", case_sensitive: true } as const;

export function parseMountTable(output: string): MountEntry[] {
  return output.split("\n").flatMap((line) => {
    const match = / on (.+) \(([^,)]+)/.exec(line);
    return match ? [{ mountPoint: String(match[1]), type: String(match[2]).trim() }] : [];
  });
}

export type DataFolderRefusal = "network_folder" | "cloud_synced_folder" | "relative_path";

export function dataFolderRefusal(
  path: string,
  context: { platform: string; home: string; mounts: MountEntry[] },
): DataFolderRefusal | null {
  if (context.platform === "win32") {
    if (path.startsWith("\\\\")) return "network_folder";
    if (!/^[A-Za-z]:\\/.test(path)) return "relative_path";
    const home = `${context.home.toLowerCase().replace(/\\+$/, "")}\\`;
    const lower = path.toLowerCase();
    if (lower.startsWith(home) && WINDOWS_SYNCED.test(lower.slice(home.length)))
      return "cloud_synced_folder";
    return null;
  }
  if (!path.startsWith("/") || path.split("/").includes("..")) return "relative_path";
  const home = `${context.home.replace(/\/+$/, "")}/`;
  if (path.startsWith(home) && MAC_SYNCED.test(path.slice(home.length)))
    return "cloud_synced_folder";
  const mount = context.mounts
    .filter((entry) => segmentsUnder(entry.mountPoint, path, MOUNT_PATHS) !== null)
    .sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
  if (mount && (NETWORK_FILESYSTEMS.has(mount.type) || FUSE_FILESYSTEM.test(mount.type)))
    return "network_folder";
  return null;
}

export function socketDirectoryFor(pgdata: string, fallback: string): string {
  const candidate = `${pgdata}/.s.PGSQL.${POSTGRES_SOCKET_PORT}`;
  return new TextEncoder().encode(candidate).byteLength <= SOCKET_PATH_MAX_BYTES
    ? pgdata
    : fallback;
}

export type DatabaseEndpoint =
  | { kind: "socket"; directory: string }
  | { kind: "tcp"; host: "127.0.0.1"; port: number };

export function laptopPostgresSettings(endpoint: DatabaseEndpoint): string[] {
  const settings: Record<string, string> = {
    shared_buffers: "64MB",
    max_connections: "50",
    work_mem: "4MB",
    maintenance_work_mem: "64MB",
    effective_cache_size: "256MB",
    max_wal_size: "256MB",
    min_wal_size: "64MB",
    checkpoint_timeout: "15min",
    autovacuum_naptime: "5min",
    jit: "off",
    max_worker_processes: "4",
    max_parallel_workers: "2",
    max_parallel_workers_per_gather: "0",
    logging_collector: "off",
    log_min_messages: "warning",
    ...(endpoint.kind === "socket"
      ? {
          listen_addresses: "",
          unix_socket_directories: endpoint.directory,
          unix_socket_permissions: "0700",
        }
      : { listen_addresses: endpoint.host, port: String(endpoint.port) }),
  };
  return Object.entries(settings).flatMap(([name, value]) => ["-c", `${name}=${value}`]);
}

export function databaseUrl(endpoint: DatabaseEndpoint, password: string): string {
  const credentials = `${LOCAL_DATABASE_USER}:${encodeURIComponent(password)}`;
  if (endpoint.kind === "tcp")
    return `postgres://${credentials}@${endpoint.host}:${endpoint.port}/${LOCAL_DATABASE}`;
  return `postgres://${credentials}@/${LOCAL_DATABASE}?host=${encodeURIComponent(endpoint.directory)}`;
}

function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`cannot compare versions ${a} and ${b}`);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export type UpgradePlan =
  | "first_run"
  | "same_version"
  | "backup_then_migrate"
  | "downgrade_refused";

export function upgradePlan(lastEngineVersion: string | null, appVersion: string): UpgradePlan {
  if (lastEngineVersion === null) return "first_run";
  const order = compareVersions(appVersion, lastEngineVersion);
  if (order === 0) return "same_version";
  return order > 0 ? "backup_then_migrate" : "downgrade_refused";
}

export type BackupReason = "update" | "manual" | "restore";

export function backupName(at: Date, reason: BackupReason): string {
  return `${at
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z")}-${reason}`;
}

export function backupsToPrune(names: string[], keep: number = BACKUPS_KEPT): string[] {
  return (["-update", "-restore"] as const).flatMap((suffix) => {
    const automatic = names.filter((name) => name.endsWith(suffix)).sort();
    return automatic.slice(0, Math.max(0, automatic.length - keep));
  });
}

export type SupervisorPhase =
  | "stopped"
  | "preparing"
  | "starting_database"
  | "backing_up"
  | "starting_engine"
  | "running"
  | "restarting"
  | "stopping"
  | "failed";

export type SupervisorEvent =
  | { type: "start" }
  | { type: "prepared"; plan: UpgradePlan }
  | { type: "database_ready" }
  | { type: "backup_done" }
  | { type: "engine_ready"; port: number }
  | { type: "crashed"; process: "database" | "engine"; plan: RestartPlan | null }
  | { type: "retry" }
  | { type: "stop" }
  | { type: "stopped" }
  | { type: "fail"; reason: string };

export interface SupervisorState {
  phase: SupervisorPhase;
  plan: UpgradePlan | null;
  port: number | null;
  reason: string | null;
}

export const INITIAL_SUPERVISOR_STATE: SupervisorState = {
  phase: "stopped",
  plan: null,
  port: null,
  reason: null,
};

export function nextSupervisorState(
  state: SupervisorState,
  event: SupervisorEvent,
): SupervisorState {
  const failed = (reason: string): SupervisorState => ({ ...state, phase: "failed", reason });
  switch (event.type) {
    case "start":
      return state.phase === "stopped" || state.phase === "failed"
        ? { phase: "preparing", plan: null, port: null, reason: null }
        : state;
    case "prepared":
      if (state.phase !== "preparing") return state;
      if (event.plan === "downgrade_refused") return failed("downgrade_refused");
      return { ...state, phase: "starting_database", plan: event.plan };
    case "database_ready":
      if (state.phase !== "starting_database" && state.phase !== "restarting") return state;
      return {
        ...state,
        phase: state.plan === "backup_then_migrate" ? "backing_up" : "starting_engine",
      };
    case "backup_done":
      return state.phase === "backing_up" ? { ...state, phase: "starting_engine" } : state;
    case "engine_ready":
      return state.phase === "starting_engine"
        ? { ...state, phase: "running", port: event.port, plan: "same_version" }
        : state;
    case "crashed":
      if (state.phase === "stopping" || state.phase === "stopped") return state;
      if (event.plan === null) return failed(`${event.process}_keeps_crashing`);
      return { ...state, phase: "restarting", port: null };
    case "retry":
      return state.phase === "restarting" ? { ...state, phase: "starting_database" } : state;
    case "stop":
      return state.phase === "stopped" ? state : { ...state, phase: "stopping" };
    case "stopped":
      return { ...INITIAL_SUPERVISOR_STATE, plan: state.plan };
    case "fail":
      return failed(event.reason);
  }
}

export function parseEngineReady(line: string): { port: number; reassigned: boolean } | null {
  if (!line.startsWith("{") || !line.includes(LOCAL_READY_EVENT)) return null;
  try {
    const value = JSON.parse(line) as { event?: unknown; port?: unknown; reassigned?: unknown };
    if (
      value.event !== LOCAL_READY_EVENT ||
      typeof value.port !== "number" ||
      !Number.isInteger(value.port) ||
      value.port < 1024 ||
      value.port > 65535
    )
      return null;
    return { port: value.port, reassigned: value.reassigned === true };
  } catch {
    return null;
  }
}
