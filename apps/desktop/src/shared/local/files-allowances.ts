import { createHash } from "node:crypto";
import {
  type DeviceAllowance,
  type FolderAccess,
  FolderAccessSchema,
  rootDigestMaterial,
  siteDigestMaterial,
} from "@shared/device/boundary.ts";
import { allowancesDigestMaterial } from "@shared/device/files.ts";
import { isPrivateClass, parseSiteEntry } from "@shared/local-policy/addresses.ts";
import { classifyPath, classifyRoot, pathAllowedPersonal } from "@shared/local-policy/paths.ts";
import type { PolicyResult } from "@shared/local-policy/result.ts";
import { z } from "zod";
import {
  appDigest,
  COMPUTER_APPS_MAX,
  COMPUTER_OFF,
  type ComputerApp,
  ComputerAppSchema,
  type ComputerSnapshot,
  addApp as checkApp,
} from "./computer-allowances.ts";

export const LOCAL_ALLOWANCES_MAX = 200;
export const OWN_TEMP_NAME = /^\.subkit-[A-Za-z0-9-]+\.(tmp|bak)$/;

const LocalFolderSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    display: z.string().min(1),
    access: FolderAccessSchema,
    volume_id: z.string().min(1),
    file_id: z.string().min(1),
    bookmark: z.string().min(1).nullable(),
    added_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type LocalFolder = z.infer<typeof LocalFolderSchema>;

const LocalKeepOutSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    display: z.string().min(1),
    added_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type LocalKeepOut = z.infer<typeof LocalKeepOutSchema>;

const LocalSiteSchema = z
  .object({
    origin: z.string().min(1).max(2048),
    private: z.boolean(),
    added_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type LocalSite = z.infer<typeof LocalSiteSchema>;

const LocalAppSchema = ComputerAppSchema.extend({
  added_at: z.iso.datetime({ offset: true }),
}).strict();
export type LocalApp = z.infer<typeof LocalAppSchema>;

export const LocalFilesStateSchema = z
  .object({
    personal_enabled: z.boolean(),
    folders: z.array(LocalFolderSchema).max(LOCAL_ALLOWANCES_MAX),
    keep_out: z.array(LocalKeepOutSchema).max(LOCAL_ALLOWANCES_MAX),
    sites: z.array(LocalSiteSchema).max(LOCAL_ALLOWANCES_MAX).default([]),
    apps: z.array(LocalAppSchema).max(COMPUTER_APPS_MAX).default([]),
    runner_ids: z.record(z.string(), z.string().min(1)),
  })
  .strict();
export type LocalFilesState = z.infer<typeof LocalFilesStateSchema>;

export const EMPTY_LOCAL_FILES: LocalFilesState = {
  personal_enabled: false,
  folders: [],
  keep_out: [],
  sites: [],
  apps: [],
  runner_ids: {},
};

export function parseLocalFiles(raw: unknown): LocalFilesState {
  const parsed = LocalFilesStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_LOCAL_FILES;
}

export const FilesSnapshotSchema = z
  .object({
    personal_enabled: z.boolean(),
    home: z.string().min(1).nullable(),
    data_dir: z.string().min(1),
    folders: z
      .array(
        z
          .object({
            id: z.string().min(1),
            path: z.string().min(1),
            display: z.string().min(1),
            access: FolderAccessSchema,
            volume_id: z.string().min(1),
            file_id: z.string().min(1),
          })
          .strict(),
      )
      .max(LOCAL_ALLOWANCES_MAX),
    keep_out: z
      .array(
        z
          .object({
            id: z.string().min(1),
            path: z.string().min(1),
            display: z.string().min(1),
          })
          .strict(),
      )
      .max(LOCAL_ALLOWANCES_MAX),
  })
  .strict();
export type FilesSnapshot = z.infer<typeof FilesSnapshotSchema>;
export type SnapshotFolder = FilesSnapshot["folders"][number];

export const EMPTY_FILES_SNAPSHOT: FilesSnapshot = {
  personal_enabled: false,
  home: null,
  data_dir: "/nonexistent-subkit-data",
  folders: [],
  keep_out: [],
};

export interface DeviceEnv {
  readonly home: string | null;
  readonly data_dir: string;
}

export function snapshotOf(state: LocalFilesState, env: DeviceEnv): FilesSnapshot {
  return {
    personal_enabled: state.personal_enabled,
    home: env.home,
    data_dir: env.data_dir,
    folders: state.folders.map(({ id, path, display, access, volume_id, file_id }) => ({
      id,
      path,
      display,
      access,
      volume_id,
      file_id,
    })),
    keep_out: state.keep_out.map(({ id, path, display }) => ({ id, path, display })),
  };
}

export function sha256Hex(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
}

export function folderDigest(
  deviceId: string,
  folder: Pick<SnapshotFolder, "path" | "volume_id" | "file_id">,
): string {
  return sha256Hex(
    rootDigestMaterial({
      device_id: deviceId,
      real_path: folder.path,
      volume_id: folder.volume_id,
      file_id: folder.file_id,
    }),
  );
}

export function displayPath(path: string, home: string | null): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

export function wireAllowances(
  deviceId: string,
  state: Pick<FilesSnapshot, "folders" | "keep_out"> &
    Partial<Pick<LocalFilesState, "sites" | "apps">>,
): DeviceAllowance[] {
  const folders: DeviceAllowance[] = state.folders.map((folder) => ({
    kind: "folder",
    id: folder.id,
    display: folder.display,
    access: folder.access,
    digest: folderDigest(deviceId, folder),
    entered_by: "person",
  }));
  const keepOut: DeviceAllowance[] = state.keep_out.map((entry) => ({
    kind: "keep_out",
    id: entry.id,
    target: "folder",
    display: entry.path,
    entered_by: "person",
  }));
  const sites: DeviceAllowance[] = (state.sites ?? []).map((site) => ({
    kind: "site",
    id: site.origin,
    origin: site.origin,
    private: site.private,
    digest: sha256Hex(
      siteDigestMaterial({ device_id: deviceId, origin: site.origin, private: site.private }),
    ),
    entered_by: "person",
  }));
  const apps: DeviceAllowance[] = (state.apps ?? []).map((app) => ({
    kind: "app",
    id: app.bundle_id,
    display: app.display,
    digest: appDigest(deviceId, app),
    entered_by: "person",
  }));
  return [...folders, ...keepOut, ...sites, ...apps];
}

export type AddedEntry =
  | { readonly ok: true; readonly id: string; readonly state: LocalFilesState }
  | {
      readonly ok: false;
      readonly code: "invalid" | "duplicate" | "full" | "blocked_app" | "keep_out";
    };

export function addSite(state: LocalFilesState, input: string, now: number): AddedEntry {
  const parsed = parseSiteEntry(input);
  if (parsed === null) return { ok: false, code: "invalid" };
  if (state.sites.some((site) => site.origin === parsed.origin))
    return { ok: false, code: "duplicate" };
  if (state.sites.length >= LOCAL_ALLOWANCES_MAX) return { ok: false, code: "full" };
  const site: LocalSite = {
    origin: parsed.origin,
    private: isPrivateClass(parsed.host_class),
    added_at: new Date(now).toISOString(),
  };
  return { ok: true, id: site.origin, state: { ...state, sites: [...state.sites, site] } };
}

export function addApp(state: LocalFilesState, app: ComputerApp, now: number): AddedEntry {
  const checked = checkApp({ ...COMPUTER_OFF, apps: state.apps }, app);
  if (!checked.ok) return checked;
  const entry: LocalApp = { ...app, added_at: new Date(now).toISOString() };
  return { ok: true, id: app.bundle_id, state: { ...state, apps: [...state.apps, entry] } };
}

export function computerOf(
  state: LocalFilesState,
  helper: ComputerSnapshot["helper"],
): Omit<ComputerSnapshot, "permissions"> {
  return {
    enabled: helper !== null,
    personal_enabled: state.personal_enabled,
    apps: state.apps.map(({ bundle_id, team_id, display }) => ({ bundle_id, team_id, display })),
    keep_out: [],
    helper,
  };
}

export function allowancesDigest(
  deviceId: string,
  state: Pick<FilesSnapshot, "folders" | "keep_out">,
): string {
  return sha256Hex(allowancesDigestMaterial(wireAllowances(deviceId, state)));
}

export interface PickedFolder {
  readonly path: string;
  readonly volume_id: string;
  readonly file_id: string;
  readonly bookmark: string | null;
}

export type PickOutcome =
  | { readonly ok: true; readonly state: LocalFilesState; readonly id: string }
  | { readonly ok: false; readonly code: string };

function samePath(left: string, right: string, caseSensitive: boolean): boolean {
  return caseSensitive
    ? left === right
    : left.normalize("NFC").toLowerCase() === right.normalize("NFC").toLowerCase();
}

export interface PickInput {
  readonly picked: PickedFolder;
  readonly env: DeviceEnv;
  readonly case_sensitive: boolean;
  readonly now: number;
}

export function allowanceId(kind: "folder" | "keep_out", picked: PickedFolder): string {
  const identity = `${picked.volume_id}:${picked.file_id}`;
  return `${kind === "folder" ? "fld" : "kpo"}_${sha256Hex(JSON.stringify([kind, identity])).slice(0, 32)}`;
}

export function pickVerdict(path: string, env: DeviceEnv, caseSensitive: boolean): PolicyResult {
  return classifyRoot(path, {
    os: "darwin",
    case_sensitive: caseSensitive,
    home: env.home,
    data_dir: env.data_dir,
  });
}

export function addFolder(
  state: LocalFilesState,
  access: FolderAccess,
  input: PickInput,
): PickOutcome {
  const verdict = pickVerdict(input.picked.path, input.env, input.case_sensitive);
  if (!verdict.ok) return { ok: false, code: verdict.code };
  const derived = allowanceId("folder", input.picked);
  const known =
    state.folders.find((folder) => folder.id === derived) ??
    state.folders.find((folder) => samePath(folder.path, input.picked.path, input.case_sensitive));
  if (!known && state.folders.length >= LOCAL_ALLOWANCES_MAX) {
    return { ok: false, code: "too_many" };
  }
  const id = known?.id ?? derived;
  const entry: LocalFolder = {
    id,
    path: input.picked.path,
    display: displayPath(input.picked.path, input.env.home),
    access,
    volume_id: input.picked.volume_id,
    file_id: input.picked.file_id,
    bookmark: input.picked.bookmark,
    added_at: known?.added_at ?? new Date(input.now).toISOString(),
  };
  const folders = known
    ? state.folders.map((folder) => (folder.id === known.id ? entry : folder))
    : [...state.folders, entry];
  return { ok: true, state: { ...state, folders }, id };
}

export function addKeepOut(state: LocalFilesState, input: PickInput): PickOutcome {
  const id = allowanceId("keep_out", input.picked);
  const known = state.keep_out.find(
    (entry) => entry.id === id || samePath(entry.path, input.picked.path, input.case_sensitive),
  );
  if (known) return { ok: true, state, id: known.id };
  if (state.keep_out.length >= LOCAL_ALLOWANCES_MAX) return { ok: false, code: "too_many" };
  const entry: LocalKeepOut = {
    id,
    path: input.picked.path,
    display: displayPath(input.picked.path, input.env.home),
    added_at: new Date(input.now).toISOString(),
  };
  return { ok: true, state: { ...state, keep_out: [...state.keep_out, entry] }, id };
}

export function removeAllowance(state: LocalFilesState, id: string): LocalFilesState {
  return {
    ...state,
    folders: state.folders.filter((folder) => folder.id !== id),
    keep_out: state.keep_out.filter((entry) => entry.id !== id),
    sites: state.sites.filter((site) => site.origin !== id),
    apps: state.apps.filter((app) => app.bundle_id !== id),
  };
}

export function setPersonalEnabled(state: LocalFilesState, enabled: boolean): LocalFilesState {
  return { ...state, personal_enabled: enabled };
}

export function setRunnerId(
  state: LocalFilesState,
  origin: string,
  runnerId: string,
): LocalFilesState {
  return { ...state, runner_ids: { ...state.runner_ids, [origin]: runnerId } };
}

export const FOLDER_STATUSES = ["available", "changed", "missing"] as const;
export type FolderStatus = (typeof FOLDER_STATUSES)[number];

export interface ObservedRoot {
  readonly real_path: string;
  readonly volume_id: string;
  readonly file_id: string;
}

export function folderStatus(
  folder: Pick<LocalFolder, "path" | "volume_id" | "file_id">,
  observed: ObservedRoot | null,
): FolderStatus {
  if (observed === null) return "missing";
  const same =
    observed.real_path === folder.path &&
    observed.volume_id === folder.volume_id &&
    observed.file_id === folder.file_id;
  return same ? "available" : "changed";
}

export function setFolderAccess(
  state: LocalFilesState,
  id: string,
  access: FolderAccess,
): LocalFilesState | null {
  if (!state.folders.some((folder) => folder.id === id)) return null;
  return {
    ...state,
    folders: state.folders.map((folder) => (folder.id === id ? { ...folder, access } : folder)),
  };
}

export interface AllowanceView {
  readonly id: string;
  readonly kind: "folder" | "keep_out" | "site" | "app";
  readonly display: string;
  readonly access: FolderAccess | null;
  readonly status: FolderStatus | null;
  readonly private: boolean;
}

export interface AllowancesView {
  readonly personal_enabled: boolean;
  readonly items: readonly AllowanceView[];
}

export function allowancesView(
  state: LocalFilesState,
  statuses: Readonly<Record<string, FolderStatus>> = {},
): AllowancesView {
  return {
    personal_enabled: state.personal_enabled,
    items: [
      ...state.folders.map((folder) => ({
        id: folder.id,
        kind: "folder" as const,
        display: folder.display,
        access: folder.access,
        status: statuses[folder.id] ?? null,
        private: false,
      })),
      ...state.sites.map((site) => ({
        id: site.origin,
        kind: "site" as const,
        display: site.origin,
        access: null,
        status: null,
        private: site.private,
      })),
      ...state.apps.map((app) => ({
        id: app.bundle_id,
        kind: "app" as const,
        display: app.display,
        access: null,
        status: null,
        private: false,
      })),
      ...state.keep_out.map((entry) => ({
        id: entry.id,
        kind: "keep_out" as const,
        display: entry.display,
        access: null,
        status: null,
        private: false,
      })),
    ],
  };
}

function relativeInside(path: string, root: string, caseSensitive: boolean): string | null {
  const base = root.replace(/\/+$/, "");
  const head = path.slice(0, base.length + 1);
  if (path.length <= base.length + 1 || !samePath(head, `${base}/`, caseSensitive)) return null;
  return path.slice(base.length + 1);
}

function ownLeftover(path: string, snapshot: FilesSnapshot, caseSensitive: boolean): boolean {
  const slash = path.lastIndexOf("/");
  const parent = path.slice(0, slash);
  const options = {
    os: "darwin" as const,
    case_sensitive: caseSensitive,
    data_dir: snapshot.data_dir,
  };
  return snapshot.folders.some((folder) => {
    if (folder.access !== "write") return false;
    if (samePath(parent, folder.path, caseSensitive)) return true;
    const rel = relativeInside(parent, folder.path, caseSensitive);
    return rel !== null && classifyPath(rel, parent, folder.path, options).ok;
  });
}

export function mayTouch(path: string, snapshot: FilesSnapshot, caseSensitive: boolean): boolean {
  if (!path.startsWith("/")) return false;
  if (OWN_TEMP_NAME.test(path.slice(path.lastIndexOf("/") + 1))) {
    return ownLeftover(path, snapshot, caseSensitive);
  }
  const options = {
    os: "darwin" as const,
    case_sensitive: caseSensitive,
    data_dir: snapshot.data_dir,
  };
  const inFolder = snapshot.folders.some((folder) => {
    if (folder.access !== "write") return false;
    const rel = relativeInside(path, folder.path, caseSensitive);
    return rel !== null && classifyPath(rel, path, folder.path, options).ok;
  });
  if (inFolder) return true;
  if (!snapshot.personal_enabled) return false;
  if (snapshot.home !== null && samePath(path, snapshot.home, caseSensitive)) return false;
  const keepOut = snapshot.keep_out.map((entry) => entry.path);
  return pathAllowedPersonal(path, path, { ...options, keep_out: keepOut }).ok;
}
