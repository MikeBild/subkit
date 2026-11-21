import { execFile } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { FolderAccess } from "@shared/device/boundary.ts";
import { type BrowserWindow, dialog } from "electron";
import { probeCaseSensitive } from "../runner/files/resolve.ts";
import type { PickFolderOptions, PickFolderResult } from "../shared/ipc.ts";
import type { ComputerApp, ComputerSnapshot } from "../shared/local/computer-allowances.ts";
import {
  type AllowancesView,
  addApp,
  addFolder,
  addKeepOut,
  addSite,
  allowancesView,
  computerOf,
  type DeviceEnv,
  type FilesSnapshot,
  type FolderStatus,
  folderStatus,
  type LocalFilesState,
  type LocalFolder,
  type LocalSite,
  mayTouch,
  type ObservedRoot,
  parseLocalFiles,
  removeAllowance,
  setFolderAccess,
  setPersonalEnabled,
  setRunnerId,
  snapshotOf,
  wireAllowances,
} from "../shared/local/files-allowances.ts";
import { readJson, writeJsonAtomic } from "./store.ts";
import { volumeIdOf } from "./volume-id.ts";
import type { WorkspaceApi } from "./workspace-api.ts";

function run(file: string, args: string[]): Promise<{ stdout: string; stderr: string } | null> {
  return new Promise((resolve) => {
    execFile(file, args, { env: {}, timeout: 5_000 }, (error, stdout, stderr) =>
      resolve(error ? null : { stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

async function appIdentity(bundle: string): Promise<ComputerApp | null> {
  const plist = join(bundle, "Contents", "Info.plist");
  const id = await run("/usr/bin/plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    plist,
  ]);
  const bundle_id = id?.stdout.trim() ?? "";
  if (!bundle_id) return null;
  const signed = await run("/usr/bin/codesign", ["-dv", "--verbose=2", bundle]);
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(signed?.stderr ?? "")?.[1] ?? null;
  return { bundle_id, team_id: team, display: basename(bundle).replace(/\.app$/, "") };
}

async function observe(folder: LocalFolder): Promise<ObservedRoot | null> {
  try {
    const real = await realpath(folder.path);
    const stats = await stat(real);
    if (!stats.isDirectory()) return null;
    return { real_path: real, volume_id: await volumeIdOf(real), file_id: String(stats.ino) };
  } catch {
    return null;
  }
}

export type SyncOutcome = "synced" | "not_enrolled" | "failed";

export interface LocalAllowancesOptions {
  readonly path: string;
  readonly env: DeviceEnv;
  readonly now: () => number;
  readonly onChange: () => void;
  readonly onError: (error: unknown) => void;
}

export class LocalAllowances {
  private state: LocalFilesState = parseLocalFiles(null);

  constructor(private readonly options: LocalAllowancesOptions) {}

  load(): void {
    this.state = parseLocalFiles(readJson(this.options.path));
  }

  private save(next: LocalFilesState): void {
    this.state = next;
    try {
      writeJsonAtomic(this.options.path, next);
    } catch (error) {
      this.options.onError(error);
    }
    this.options.onChange();
  }

  async view(): Promise<AllowancesView> {
    const statuses: Record<string, FolderStatus> = {};
    for (const folder of this.state.folders) {
      statuses[folder.id] = folderStatus(folder, await observe(folder));
    }
    return allowancesView(this.state, statuses);
  }

  setAccess(id: string, access: FolderAccess): Promise<AllowancesView> {
    const next = setFolderAccess(this.state, id, access);
    if (next) this.save(next);
    return this.view();
  }

  snapshot(): FilesSnapshot {
    return snapshotOf(this.state, this.options.env);
  }

  personalEnabled(): boolean {
    return this.state.personal_enabled;
  }

  sites(): readonly LocalSite[] {
    return this.state.sites;
  }

  computer(helper: ComputerSnapshot["helper"]): Omit<ComputerSnapshot, "permissions"> {
    return computerOf(this.state, helper);
  }

  addSite(origin: string): Promise<AllowancesView> {
    const added = addSite(this.state, origin, this.options.now());
    if (added.ok) this.save(added.state);
    return this.view();
  }

  async pickApp(window: BrowserWindow | null): Promise<PickFolderResult> {
    const dialogOptions = {
      defaultPath: "/Applications",
      properties: ["openFile"] as "openFile"[],
      filters: [{ name: "Apps", extensions: ["app"] }],
    };
    const chosen = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    const [picked] = chosen.filePaths;
    if (chosen.canceled || !picked) return { status: "cancelled" };
    const app = await appIdentity(picked);
    if (!app) return { status: "refused", code: "not_an_app" };
    const added = addApp(this.state, app, this.options.now());
    if (!added.ok) return { status: "refused", code: added.code };
    this.save(added.state);
    return { status: "added", id: added.id, view: await this.view() };
  }

  setPersonalEnabled(enabled: boolean): Promise<AllowancesView> {
    this.save(setPersonalEnabled(this.state, enabled));
    return this.view();
  }

  remove(id: string): Promise<AllowancesView> {
    this.save(removeAllowance(this.state, id));
    return this.view();
  }

  runnerIdFor(origin: string): string | null {
    return this.state.runner_ids[origin] ?? null;
  }

  rememberRunner(origin: string, runnerId: string): void {
    this.save(setRunnerId(this.state, origin, runnerId));
  }

  async pick(window: BrowserWindow | null, options: PickFolderOptions): Promise<PickFolderResult> {
    const dialogOptions = {
      properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      securityScopedBookmarks: true,
    };
    const chosen = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    const [picked] = chosen.filePaths;
    if (chosen.canceled || !picked) return { status: "cancelled" };
    let path: string;
    try {
      path = realpathSync.native(picked);
    } catch {
      return { status: "refused", code: "not_found" };
    }
    const stats = statSync(path);
    if (!stats.isDirectory()) return { status: "refused", code: "not_a_folder" };
    const input = {
      picked: {
        path,
        volume_id: await volumeIdOf(path),
        file_id: String(stats.ino),
        bookmark: chosen.bookmarks?.[0] || null,
      },
      env: this.options.env,
      case_sensitive: await probeCaseSensitive(path),
      now: this.options.now(),
    };
    const outcome = options.keepOut
      ? addKeepOut(this.state, input)
      : addFolder(this.state, options.access ?? "read", input);
    if (!outcome.ok) return { status: "refused", code: outcome.code };
    this.save(outcome.state);
    return { status: "added", id: outcome.id, view: await this.view() };
  }

  mayTouch(path: string): boolean {
    try {
      const parent = realpathSync.native(dirname(path));
      if (`${parent === "/" ? "" : parent}/${basename(path)}` !== path) return false;
      if (lstatSync(path).isSymbolicLink()) return false;
    } catch {
      return false;
    }
    return mayTouch(path, this.snapshot(), false);
  }

  async sync(api: WorkspaceApi | null, origin: string | null): Promise<SyncOutcome> {
    const runnerId = origin ? this.runnerIdFor(origin) : null;
    if (!api || !runnerId) return "not_enrolled";
    const body = JSON.stringify({
      allowances: wireAllowances(runnerId, {
        ...this.snapshot(),
        sites: this.state.sites,
        apps: this.state.apps,
      }),
    });
    const response = await api.send(
      "PUT",
      `/v1/devices/${encodeURIComponent(runnerId)}/allowances`,
      body,
    );
    return response.status === 200 ? "synced" : "failed";
  }
}
