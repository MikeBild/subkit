import { randomBytes } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ListedObject, ObjectHead, ObjectStore } from "./object-store.ts";

export const STAGING_DIR = "%incoming";
const MAX_KEY_BYTES = 1024;
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;
const MAX_SEGMENT_BYTES = 255;
const SAFE_BYTE = /^[a-z0-9._-]$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export type FileSystemStoreErrorCode =
  | "root_not_absolute"
  | "root_parent_missing"
  | "root_not_directory"
  | "root_not_writable"
  | "root_cross_device"
  | "root_no_hard_links";

const REMEDIES: Record<FileSystemStoreErrorCode, string> = {
  root_not_absolute: "Set OBJECT_STORAGE_ROOT to an absolute folder path.",
  root_parent_missing: "Create the parent folder of OBJECT_STORAGE_ROOT, or choose another folder.",
  root_not_directory: "Point OBJECT_STORAGE_ROOT at a folder, not a file.",
  root_not_writable:
    "Give the engine's user write access to the folder, or choose a folder it owns.",
  root_cross_device:
    "Keep the whole files folder on one local disk; do not mount another volume inside it.",
  root_no_hard_links:
    "Choose a folder on a local disk formatted with APFS, HFS+, NTFS or ext4; network drives and exFAT are not supported.",
};

export class FileSystemStoreError extends Error {
  readonly code: FileSystemStoreErrorCode;
  readonly remedy: string;
  constructor(code: FileSystemStoreErrorCode, detail: string) {
    super(`${detail}. ${REMEDIES[code]}`);
    this.name = "FileSystemStoreError";
    this.code = code;
    this.remedy = REMEDIES[code];
  }
}

function notStorable(key: string, reason: string): Error {
  return new Error(`object key is not storable on disk (${reason}): ${key}`);
}

function hex(byte: number): string {
  return `%${byte.toString(16).padStart(2, "0")}`;
}

function encodeSegment(segment: string, key: string): string {
  if (segment === "" || segment === "." || segment === "..")
    throw notStorable(key, "empty, . or .. segment");
  const bytes = Buffer.from(segment, "utf8");
  const parts: string[] = [];
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    parts.push(byte < 0x80 && SAFE_BYTE.test(char) ? char : hex(byte));
  }
  if (WINDOWS_RESERVED.test(segment)) parts[0] = hex(bytes[0]!);
  if (parts[parts.length - 1] === ".") parts[parts.length - 1] = hex(0x2e);
  const encoded = parts.join("");
  if (encoded.length > MAX_SEGMENT_BYTES) throw notStorable(key, "segment too long");
  return encoded;
}

function decodeSegment(encoded: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 1) {
    const char = encoded[i]!;
    if (char === "%") {
      const pair = encoded.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/.test(pair)) return null;
      bytes.push(Number.parseInt(pair, 16));
      i += 2;
    } else if (SAFE_BYTE.test(char)) {
      bytes.push(char.charCodeAt(0));
    } else {
      return null;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export function encodeObjectKey(key: string): string[] {
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) throw notStorable(key, "key too long");
  if (key.startsWith("/")) throw notStorable(key, "absolute key");
  return key.split("/").map((segment) => encodeSegment(segment, key));
}

export function decodeObjectKey(segments: string[]): string | null {
  const decoded: string[] = [];
  for (const segment of segments) {
    const value = decodeSegment(segment);
    if (value === null) return null;
    decoded.push(value);
  }
  return decoded.join("/");
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    offset += bytesWritten;
  }
}

async function* single(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function* streamHandle(
  handle: FileHandle,
  range: { start?: number; end?: number },
): AsyncIterable<Uint8Array> {
  try {
    yield* handle.createReadStream({
      autoClose: false,
      ...(range.start !== undefined ? { start: range.start } : {}),
      ...(range.end !== undefined ? { end: range.end } : {}),
    });
  } finally {
    await handle.close().catch(() => {});
  }
}

export class FileSystemObjectStore implements ObjectStore {
  private readonly configuredRoot: string;
  private prepared: Promise<string> | null = null;

  constructor(root: string) {
    if (!isAbsolute(root))
      throw new FileSystemStoreError(
        "root_not_absolute",
        `the filesystem object store root "${root}" is not an absolute path`,
      );
    this.configuredRoot = resolve(root);
  }

  private root(): Promise<string> {
    if (!this.prepared) {
      this.prepared = this.prepare();
      this.prepared.catch(() => {
        this.prepared = null;
      });
    }
    return this.prepared;
  }

  private async prepare(): Promise<string> {
    const configured = this.configuredRoot;
    try {
      await mkdir(configured, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === "ENOENT")
        throw new FileSystemStoreError(
          "root_parent_missing",
          `the parent folder of the filesystem object store root ${configured} does not exist`,
        );
      if (errorCode(error) === "EACCES" || errorCode(error) === "EPERM")
        throw new FileSystemStoreError(
          "root_not_writable",
          `the filesystem object store root ${configured} cannot be created`,
        );
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const root = await realpath(configured);
    const info = await stat(root);
    if (!info.isDirectory())
      throw new FileSystemStoreError(
        "root_not_directory",
        `the filesystem object store root ${configured} is not a folder`,
      );
    const staging = join(root, STAGING_DIR);
    try {
      await chmod(root, 0o700);
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await this.sweepStaging(staging);
    } catch (error) {
      if (errorCode(error) === "EACCES" || errorCode(error) === "EPERM")
        throw new FileSystemStoreError(
          "root_not_writable",
          `the filesystem object store root ${configured} is not writable`,
        );
      throw error;
    }
    const stagingInfo = await lstat(staging);
    if (!stagingInfo.isDirectory() || stagingInfo.dev !== info.dev)
      throw new FileSystemStoreError(
        "root_cross_device",
        `the staging folder ${staging} is not on the same device as ${configured}`,
      );
    await this.probeHardLinks(staging);
    return root;
  }

  private async sweepStaging(staging: string): Promise<void> {
    const cutoff = Date.now() - STALE_STAGING_MS;
    for (const entry of await readdir(staging)) {
      const path = join(staging, entry);
      const info = await lstat(path).catch(() => null);
      if (info && info.mtimeMs < cutoff) await unlink(path).catch(() => {});
    }
  }

  private async probeHardLinks(staging: string): Promise<void> {
    const source = join(staging, `probe-${randomBytes(8).toString("hex")}`);
    const target = `${source}.link`;
    let handle: FileHandle;
    try {
      handle = await open(source, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EACCES" || errorCode(error) === "EPERM")
        throw new FileSystemStoreError(
          "root_not_writable",
          `the filesystem object store root ${this.configuredRoot} is not writable`,
        );
      throw error;
    }
    await handle.close();
    try {
      await link(source, target);
    } catch (error) {
      throw new FileSystemStoreError(
        "root_no_hard_links",
        `the folder ${this.configuredRoot} does not support atomic no-overwrite writes (${errorCode(error) ?? "link failed"})`,
      );
    } finally {
      await unlink(target).catch(() => {});
      await unlink(source).catch(() => {});
    }
  }

  private async pathOf(key: string): Promise<{ root: string; path: string }> {
    const root = await this.root();
    const path = join(root, ...encodeObjectKey(key));
    if (!within(root, path) || path === root) throw notStorable(key, "escapes the store");
    if (path === join(root, STAGING_DIR) || path.startsWith(join(root, STAGING_DIR) + sep))
      throw notStorable(key, "reserved");
    return { root, path };
  }

  private async assertParentInside(root: string, path: string, key: string): Promise<void> {
    const parent = await realpath(dirname(path));
    if (!within(root, parent)) throw notStorable(key, "escapes the store");
  }

  private async openExisting(key: string): Promise<FileHandle | null> {
    const { root, path } = await this.pathOf(key);
    try {
      await this.assertParentInside(root, path, key);
      const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
      if (!(await handle.stat()).isFile()) {
        await handle.close();
        return null;
      }
      return handle;
    } catch (error) {
      if (isMissing(error) || errorCode(error) === "ELOOP") return null;
      throw error;
    }
  }

  private async commit(
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentLength: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(contentLength) || contentLength < 0)
      throw new Error("object upload requires a known non-negative Content-Length");
    const { root, path } = await this.pathOf(key);
    const temporary = join(root, STAGING_DIR, randomBytes(16).toString("hex"));
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      let written = 0;
      try {
        for await (const chunk of body) {
          written += chunk.byteLength;
          if (written > contentLength)
            throw new Error(`object upload exceeded declared Content-Length ${contentLength}`);
          await writeAll(handle, chunk);
        }
        if (written !== contentLength)
          throw new Error(
            `object upload length ${written} did not match declared Content-Length ${contentLength}`,
          );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await this.assertParentInside(root, path, key);
      try {
        await link(temporary, path);
      } catch (error) {
        if (errorCode(error) === "EEXIST")
          throw new Error(`object key already exists and is immutable: ${key}`);
        throw error;
      }
      await syncDirectory(dirname(path));
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async headBucket(): Promise<void> {
    await this.root();
  }

  async put(key: string, body: Buffer | Uint8Array): Promise<void> {
    await this.commit(key, single(body), body.byteLength);
  }

  async putStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentLength: number,
  ): Promise<void> {
    await this.commit(key, body, contentLength);
  }

  async get(key: string): Promise<Buffer> {
    const handle = await this.openExisting(key);
    if (!handle) throw new Error(`object not found: ${key}`);
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async openRead(key: string): Promise<AsyncIterable<Uint8Array>> {
    return this.openReadRange(key, {});
  }

  async openReadRange(
    key: string,
    range: { start?: number; end?: number },
  ): Promise<AsyncIterable<Uint8Array>> {
    const handle = await this.openExisting(key);
    if (!handle) throw new Error(`object not found: ${key}`);
    return streamHandle(handle, range);
  }

  async head(key: string): Promise<ObjectHead | null> {
    const handle = await this.openExisting(key);
    if (!handle) return null;
    try {
      return { size: (await handle.stat()).size };
    } finally {
      await handle.close();
    }
  }

  async list(prefix: string): Promise<ListedObject[]> {
    const root = await this.root();
    const listed: ListedObject[] = [];
    const walk = async (directory: string, segments: string[]): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      for (const entry of entries) {
        if (segments.length === 0 && entry.name === STAGING_DIR) continue;
        const key = decodeObjectKey([...segments, entry.name]);
        if (key === null) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (prefix.startsWith(`${key}/`) || key.startsWith(prefix))
            await walk(path, [...segments, entry.name]);
        } else if (entry.isFile() && key.startsWith(prefix)) {
          const info = await lstat(path);
          listed.push({ key, size: info.size, last_modified: info.mtime });
        }
      }
    };
    await walk(root, []);
    return listed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async delete(key: string): Promise<void> {
    const { root, path } = await this.pathOf(key);
    try {
      await this.assertParentInside(root, path, key);
      await unlink(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) await this.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }
}
