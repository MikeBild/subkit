import { readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogValue } from "../shared/app-log.ts";

export const UPDATE_MARKER_FILE = "update-pending.json";
export const SHIPIT_TAIL_LINES = 40;

export interface DiagnosticsIo {
  device(path: string): number | null;
  freeBytes(path: string): number | null;
  readText(path: string): string | null;
  writeText(path: string, text: string): void;
  remove(path: string): void;
}

export interface DiagnosticsLog {
  info(event: string, fields?: Record<string, LogValue>): void;
  warn(event: string, fields?: Record<string, LogValue>): void;
}

export interface DiagnosticsEnv {
  execPath: string;
  tmpDir: string;
  homeDir: string;
  userDataDir: string;
  bundleId: string;
  platform: string;
  version: string;
}

export interface UpdateMarker {
  expected: string;
  from: string;
}

export interface VolumeReport {
  bundle: string | null;
  bundle_dev: number | null;
  tmp_dir: string;
  tmp_dev: number | null;
  cross_volume: boolean | null;
  bundle_free_bytes: number | null;
  tmp_free_bytes: number | null;
}

export const bundlePathOf = (execPath: string): string | null =>
  /^(.*?\.app)(?:\/|$)/.exec(execPath)?.[1] ?? null;

export const shipItCacheDir = (homeDir: string, bundleId: string): string =>
  join(homeDir, "Library", "Caches", `${bundleId}.ShipIt`);

export const markerPath = (userDataDir: string): string => join(userDataDir, UPDATE_MARKER_FILE);

export const tailOf = (text: string, count = SHIPIT_TAIL_LINES): string[] =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-count);

export function plistSummary(text: string): { format: string; entries: string[] } {
  if (text.startsWith("bplist"))
    return {
      format: "binary",
      entries: (text.match(/[\x20-\x7e]{4,}/g) ?? []).filter(
        (entry) => !entry.startsWith("bplist"),
      ),
    };
  const entries = [...text.matchAll(/<key>([^<]*)<\/key>\s*<(\w+)\s*\/?>(?:([^<]*)<\/\2>)?/g)].map(
    ([, key, tag, value]) => `${key}=${value ?? tag}`,
  );
  return { format: "xml", entries };
}

export function parseMarker(text: string | null): UpdateMarker | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<UpdateMarker>;
    return typeof value.expected === "string" && typeof value.from === "string"
      ? { expected: value.expected, from: value.from }
      : null;
  } catch {
    return null;
  }
}

export function volumeReport(env: DiagnosticsEnv, io: DiagnosticsIo): VolumeReport {
  const bundle = bundlePathOf(env.execPath);
  const bundleDevice = bundle ? io.device(bundle) : null;
  const tmpDevice = io.device(env.tmpDir);
  return {
    bundle,
    bundle_dev: bundleDevice,
    tmp_dir: env.tmpDir,
    tmp_dev: tmpDevice,
    cross_volume: bundleDevice === null || tmpDevice === null ? null : bundleDevice !== tmpDevice,
    bundle_free_bytes: bundle ? io.freeBytes(bundle) : null,
    tmp_free_bytes: io.freeBytes(env.tmpDir),
  };
}

export function logVolumes(
  stage: string,
  version: string,
  env: DiagnosticsEnv,
  io: DiagnosticsIo,
  log: DiagnosticsLog,
): VolumeReport {
  const report = volumeReport(env, io);
  const fields = { stage, version, current: env.version, ...report };
  if (report.cross_volume) log.warn("update.volumes", fields);
  else log.info("update.volumes", fields);
  return report;
}

export function recordInstallAttempt(
  expected: string,
  env: DiagnosticsEnv,
  io: DiagnosticsIo,
  log: DiagnosticsLog,
): void {
  logVolumes("before_install", expected, env, io, log);
  const marker: UpdateMarker = { expected, from: env.version };
  io.writeText(markerPath(env.userDataDir), JSON.stringify(marker));
  log.info("update.marker", { expected, from: env.version });
}

export function logShipIt(env: DiagnosticsEnv, io: DiagnosticsIo, log: DiagnosticsLog): void {
  const dir = shipItCacheDir(env.homeDir, env.bundleId);
  const stderr = io.readText(join(dir, "ShipIt_stderr.log"));
  const state = io.readText(join(dir, "ShipItState.plist"));
  log.info("update.shipit", {
    dir,
    present: io.device(dir) !== null,
    stderr_present: stderr !== null,
    state_present: state !== null,
  });
  if (state !== null) {
    const { format, entries } = plistSummary(state);
    log.info("update.shipit_state", { format, entries: entries.join(" | ") });
  }
  if (stderr === null) return;
  const lines = tailOf(stderr);
  for (const [index, line] of lines.entries())
    log.info("update.shipit_stderr", { line_no: index + 1, of: lines.length, line });
}

export function reportPreviousUpdate(
  env: DiagnosticsEnv,
  io: DiagnosticsIo,
  log: DiagnosticsLog,
): UpdateMarker | null {
  const path = markerPath(env.userDataDir);
  const marker = parseMarker(io.readText(path));
  if (!marker) return null;
  io.remove(path);
  const bundle = bundlePathOf(env.execPath);
  const bundlePresent = bundle ? io.device(bundle) !== null : null;
  const matched = marker.expected === env.version;
  const fields = {
    expected: marker.expected,
    from: marker.from,
    actual: env.version,
    matched,
    bundle,
    bundle_present: bundlePresent,
  };
  if (matched && bundlePresent !== false) log.info("update.result", fields);
  else log.warn("update.result", fields);
  if (env.platform === "darwin") logShipIt(env, io, log);
  return marker;
}

const quietly = <T>(read: () => T): T | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

export const nodeDiagnosticsIo: DiagnosticsIo = {
  device: (path) => quietly(() => statSync(path).dev),
  freeBytes: (path) =>
    quietly(() => {
      const stats = statfsSync(path);
      return Number(stats.bavail) * Number(stats.bsize);
    }),
  readText: (path) => quietly(() => readFileSync(path, "utf8")),
  writeText: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  remove: (path) => rmSync(path, { force: true }),
};
