import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DeviceSubBoundary, FolderAccess } from "@shared/device/boundary.ts";
import type { FileTarget } from "@shared/device/files.ts";
import {
  type DeviceCommand,
  type DeviceResult,
  DeviceResultSchema,
} from "@shared/device/protocol.ts";
import { classifyRoot, pathAllowedPersonal } from "@shared/local-policy/paths.ts";
import {
  type FilesSnapshot,
  folderDigest,
  type SnapshotFolder,
} from "../../shared/local/files-allowances.ts";
import { command } from "../../shared/local/runner-queue.fixture.ts";
import type { FilesDeps, FilesHooks, ImportSession } from "./context.ts";
import { createFilesAdapter } from "./driver.ts";
import type { FilesPolicy } from "./resolve.ts";

export const DEVICE = "device-1";
export const MAPPED = "/Users/test";

export interface Tree {
  readonly base: string;
  readonly home: string;
  readonly docs: string;
  readonly out: string;
  readonly reports: string;
  readonly data: string;
  readonly trash: string;
  readonly policy: FilesPolicy;
  folder(id: string, path: string, access: FolderAccess): SnapshotFolder;
  file(path: string, content?: string | Uint8Array, mode?: number): string;
  cleanup(): void;
}

export function makeTree(): Tree {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "subkit-d2-")));
  const home = join(base, "home");
  const docs = join(home, "Docs");
  const reports = join(home, "Reports");
  const out = join(base, "outside");
  const data = join(home, "Library", "Application Support", "SubKit");
  const trash = join(base, "Trash");
  for (const dir of [docs, reports, out, data, trash]) mkdirSync(dir, { recursive: true });
  const remap = (path: string) => (path.startsWith(base) ? MAPPED + path.slice(base.length) : path);
  const remapOrNull = (path: string | null | undefined) =>
    typeof path === "string" ? remap(path) : null;
  const policy: FilesPolicy = {
    classifyRoot: (root, options) =>
      classifyRoot(remap(root), {
        ...options,
        home: remapOrNull(options.home),
        data_dir: remapOrNull(options.data_dir),
      }),
    pathAllowedPersonal: (lexical, real, options) =>
      pathAllowedPersonal(remap(lexical), remap(real), {
        ...options,
        data_dir: remapOrNull(options.data_dir),
        keep_out: options.keep_out.map(remap),
      }),
  };
  return {
    base,
    home,
    docs,
    out,
    reports,
    data,
    trash,
    policy,
    folder(id, path, access) {
      const stats = statSync(path);
      return {
        id,
        path,
        display: path,
        access,
        volume_id: String(stats.dev),
        file_id: String(stats.ino),
      };
    },
    file(path, content = "hello", mode = 0o644) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { mode });
      return path;
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export function snapshotFor(
  tree: Tree,
  folders: readonly SnapshotFolder[],
  keepOut: readonly string[] = [],
  personalEnabled = true,
): FilesSnapshot {
  return {
    personal_enabled: personalEnabled,
    home: tree.home,
    data_dir: tree.data,
    folders: [...folders],
    keep_out: keepOut.map((path, index) => ({ id: `k${index}`, path, display: path })),
  };
}

export function boundaryFor(
  folders: readonly SnapshotFolder[],
  access?: FolderAccess,
): DeviceSubBoundary {
  return {
    device_id: DEVICE,
    capability: "files",
    folders: folders.map((folder) => ({
      folder_id: folder.id,
      access: access ?? folder.access,
      root_digest: folderDigest(DEVICE, folder),
    })),
  };
}

export interface FakeImporter {
  readonly bytes: Uint8Array[];
  committed: string | null;
  aborted: boolean;
}

export interface Harness {
  readonly trashed: string[];
  readonly marked: string[];
  readonly imported: FakeImporter;
  run(
    kind: DeviceCommand["kind"],
    args: unknown,
    overrides?: Partial<DeviceCommand>,
    signal?: AbortSignal,
  ): Promise<DeviceResult>;
}

export interface HarnessOptions {
  readonly tree: Tree;
  readonly snapshot: FilesSnapshot;
  readonly trashWorks?: boolean | undefined;
  readonly trashAnswersFalse?: boolean | undefined;
  readonly hooks?: FilesHooks | undefined;
  readonly policy?: FilesPolicy | undefined;
  readonly volumeId?: ((path: string, dev: number) => Promise<string>) | undefined;
  readonly progress?: ((commandId: string, note: string) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

export function harness(options: HarnessOptions): Harness {
  const trashed: string[] = [];
  const marked: string[] = [];
  const imported: FakeImporter = { bytes: [], committed: null, aborted: false };
  const session: ImportSession = {
    write: async (chunk) => {
      imported.bytes.push(chunk);
    },
    commit: async (sha256) => {
      imported.committed = sha256;
      return { file_id: "file-1" };
    },
    abort: async () => {
      imported.aborted = true;
    },
  };
  const deps: FilesDeps = {
    device_id: DEVICE,
    snapshot: () => options.snapshot,
    policy: options.policy ?? options.tree.policy,
    volumeId: options.volumeId,
    progress: options.progress,
    now: options.now,
    hooks: options.hooks,
    trash: async (path) => {
      if (options.trashWorks === false) return false;
      renameSync(path, join(options.tree.trash, `${randomUUID()}-${basename(path)}`));
      trashed.push(path);
      return options.trashAnswersFalse !== true;
    },
    mark: async (path) => {
      marked.push(path);
      return true;
    },
    importer: { begin: async () => session },
  };
  const adapter = createFilesAdapter(deps, "test");
  return {
    trashed,
    marked,
    imported,
    async run(kind, args, overrides = {}, signal = new AbortController().signal) {
      const result = await adapter.execute(command("c1", { kind, args, ...overrides }), signal);
      DeviceResultSchema.parse(result);
      return result;
    },
  };
}

export function inFolder(folder: SnapshotFolder, path: string): FileTarget {
  return { folder_id: folder.id, path };
}

export const PERSONAL = { execution_id: null, task_run_id: "task-1" } as const;
