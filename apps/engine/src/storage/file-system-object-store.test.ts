import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig } from "../config/loader.ts";
import { ConfigSchema } from "../config/schema.ts";
import { probeLocalObjectStore } from "../preflight/index.ts";
import { waitFor } from "../test-helpers/determinism/index.ts";
import {
  bindProcessStorage,
  FILESYSTEM_BUCKET,
  filesystemRoot,
  isBootstrapStoragePath,
  objectStoreBucket,
  objectStoreNamespace,
} from "./backend.ts";
import {
  decodeObjectKey,
  encodeObjectKey,
  FileSystemObjectStore,
  FileSystemStoreError,
  type FileSystemStoreErrorCode,
  STAGING_DIR,
} from "./file-system-object-store.ts";
import {
  getObjectStore,
  MemoryObjectStore,
  preflightObjectStoreConfig,
  resetObjectStoreForRuntimeConfig,
} from "./object-store.ts";

const base = mkdtempSync(join(tmpdir(), "sk-fs-store-"));
let folders = 0;
const freshRoot = () => {
  folders += 1;
  return join(base, `root-${folders}`);
};

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

async function rejectsWith(
  promise: Promise<unknown>,
  code: FileSystemStoreErrorCode,
): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(FileSystemStoreError);
  expect((error as FileSystemStoreError).code).toBe(code);
  expect((error as FileSystemStoreError).remedy.length).toBeGreaterThan(0);
}

describe("key encoding", () => {
  test("engine keys stay readable and round-trip", () => {
    const key = "offload/7f0c/2b1e/9c2d.json";
    expect(encodeObjectKey(key)).toEqual(["offload", "7f0c", "2b1e", "9c2d.json"]);
    expect(decodeObjectKey(encodeObjectKey(key))).toBe(key);
  });

  test("case, unicode and platform-hostile characters encode reversibly into safe names", () => {
    for (const key of [
      "t/Report.JSON",
      "t/café",
      "t/café",
      "t/a b:c*?<>|\\d",
      "t/100%",
      "t/CON",
      "t/nul.json",
      "t/com1",
      "t/trailing.",
      "t/trailing ",
    ]) {
      const segments = encodeObjectKey(key);
      for (const segment of segments) expect(segment).toMatch(/^[a-z0-9._%-]+$/);
      expect(segments.at(-1)?.endsWith(".")).toBe(false);
      expect(decodeObjectKey(segments)).toBe(key);
    }
    expect(encodeObjectKey("t/CON")[1]).not.toMatch(/^con/i);
    expect(encodeObjectKey("t/nul.json")[1]).not.toMatch(/^nul/i);
    expect(encodeObjectKey("t/café")).not.toEqual(encodeObjectKey("t/café"));
    expect(encodeObjectKey("t/A")).not.toEqual(encodeObjectKey("t/a"));
  });

  test("traversal, absolute, empty and oversized keys are refused", () => {
    for (const key of ["", "../x", "a/../b", "a/./b", "/abs", "a//b", "a/", "x".repeat(1025)])
      expect(() => encodeObjectKey(key)).toThrow(/not storable/);
    expect(encodeObjectKey("..%2f..%2fetc")).toEqual(["..%252f..%252fetc"]);
    expect(encodeObjectKey(".incoming")).toEqual([".incoming"]);
    expect(encodeObjectKey(STAGING_DIR.slice(1))).not.toEqual([STAGING_DIR]);
  });
});

describe("filesystem object store on disk", () => {
  test("creates the root 0700 and writes objects 0600 inside 0700 folders", async () => {
    const root = freshRoot();
    const store = new FileSystemObjectStore(root);
    await store.put("tenant/2026/11/21/object", Buffer.from("x"));
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "tenant", "2026")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "tenant/2026/11/21/object")).mode & 0o777).toBe(0o600);
  });

  test("tightens an existing root to 0700 and clears stale staging files", async () => {
    const root = freshRoot();
    mkdirSync(join(root, STAGING_DIR), { recursive: true });
    chmodSync(root, 0o755);
    writeFileSync(join(root, STAGING_DIR, "stale"), "half-written");
    utimesSync(join(root, STAGING_DIR, "stale"), new Date(0), new Date(0));
    const store = new FileSystemObjectStore(root);
    await store.headBucket();
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(root, STAGING_DIR))).toEqual([]);
  });

  test("a second store on the same folder keeps a write that is still in flight", async () => {
    const root = freshRoot();
    const writer = new FileSystemObjectStore(root);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* gated(): AsyncIterable<Uint8Array> {
      yield Buffer.from("first-");
      await gate;
      yield Buffer.from("second");
    }
    const pending = writer.putStream("inflight/key", gated(), 12);
    await waitFor(() => {
      try {
        return readdirSync(join(root, STAGING_DIR)).length === 1;
      } catch {
        return false;
      }
    });
    await new FileSystemObjectStore(root).headBucket();
    release();
    await pending;
    expect((await writer.get("inflight/key")).toString()).toBe("first-second");
  });

  test("leaves no staging files after successful and failed writes", async () => {
    const root = freshRoot();
    const store = new FileSystemObjectStore(root);
    await store.put("a/ok", Buffer.from("ok"));
    await store.put("a/ok", Buffer.from("again")).catch(() => {});
    async function* broken(): AsyncIterable<Uint8Array> {
      yield Buffer.from("x");
      throw new Error("boom");
    }
    await store.putStream("a/broken", broken(), 5).catch(() => {});
    expect(readdirSync(join(root, STAGING_DIR))).toEqual([]);
    expect((await store.list("")).map((item) => item.key)).toEqual(["a/ok"]);
  });

  test("concurrent writers of one key: exactly one wins, the other sees immutable", async () => {
    const store = new FileSystemObjectStore(freshRoot());
    const results = await Promise.allSettled([
      store.put("race/key", Buffer.from("first")),
      store.put("race/key", Buffer.from("second")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(/immutable/);
    expect(["first", "second"]).toContain((await store.get("race/key")).toString());
  });

  test("a symlink planted inside the root cannot lead reads or writes outside it", async () => {
    const root = freshRoot();
    const outside = join(base, `outside-${folders}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret"), "outside");
    const store = new FileSystemObjectStore(root);
    await store.headBucket();
    symlinkSync(outside, join(root, "evil"));
    symlinkSync(join(outside, "secret"), join(root, "link"));
    await expect(store.get("evil/secret")).rejects.toThrow(/escapes the store/);
    await expect(store.put("evil/new", Buffer.from("x"))).rejects.toThrow(/escapes the store/);
    await expect(store.get("link")).rejects.toThrow(/object not found/);
    expect(await store.head("link")).toBeNull();
    expect(readdirSync(outside)).toEqual(["secret"]);
    expect(await store.list("")).toEqual([]);
  });

  test("list ignores the staging folder and names that are not encoded keys", async () => {
    const root = freshRoot();
    const store = new FileSystemObjectStore(root);
    await store.put("k/One", Buffer.from("1"));
    writeFileSync(join(root, "k", "Stray.txt"), "not ours");
    expect((await store.list("k/")).map((item) => item.key)).toEqual(["k/One"]);
  });
});

describe("startup checks", () => {
  test("a relative root is refused", () => {
    expect(() => new FileSystemObjectStore("relative/files")).toThrow(FileSystemStoreError);
  });

  test("a missing parent folder is refused with a remedy", async () => {
    const store = new FileSystemObjectStore(join(base, "missing-parent", "files"));
    await rejectsWith(store.headBucket(), "root_parent_missing");
  });

  test("a file in place of the root is refused", async () => {
    const path = join(base, "a-file");
    writeFileSync(path, "x");
    await rejectsWith(new FileSystemObjectStore(path).headBucket(), "root_not_directory");
  });

  test.skipIf(process.getuid?.() === 0)("a root that cannot be created is refused", async () => {
    const parent = freshRoot();
    mkdirSync(parent, { mode: 0o500 });
    try {
      await rejectsWith(
        new FileSystemObjectStore(join(parent, "files")).headBucket(),
        "root_not_writable",
      );
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  test("a failed check is retried on the next call", async () => {
    const parent = join(base, "later-parent");
    const store = new FileSystemObjectStore(join(parent, "files"));
    await rejectsWith(store.headBucket(), "root_parent_missing");
    mkdirSync(parent);
    await expect(store.headBucket()).resolves.toBeUndefined();
  });

  test("preflight probes the local folder and leaves nothing behind", async () => {
    const root = freshRoot();
    await probeLocalObjectStore(root);
    expect(await new FileSystemObjectStore(root).list("")).toEqual([]);
    await expect(probeLocalObjectStore(join(base, "nope", "files"))).rejects.toThrow(
      FileSystemStoreError,
    );
  });
});

describe("backend selection", () => {
  const s3 = ConfigSchema.parse({ database: { url: "postgres://x" } }).storage;
  const local = ConfigSchema.parse({
    database: { url: "postgres://x" },
    storage: { backend: "filesystem", filesystem: { root: "/data/files" } },
  }).storage;

  test("server mode stays on S3 by default", () => {
    expect(s3.backend).toBe("s3");
    expect(filesystemRoot(s3)).toBeNull();
    expect(objectStoreBucket(s3)).toBe(s3.object_store.bucket);
  });

  test("filesystem mode names a fixed bucket and a namespace that ignores the root", () => {
    expect(filesystemRoot(local)).toBe("/data/files");
    expect(objectStoreBucket(local)).toBe(FILESYSTEM_BUCKET);
    const moved = structuredClone(local);
    moved.filesystem.root = "/elsewhere/files";
    expect(objectStoreNamespace(moved)).toBe(objectStoreNamespace(local));
    expect(objectStoreNamespace(local)).not.toBe(objectStoreNamespace(s3));
  });

  test("the S3 namespace hash is unchanged", () => {
    const storage = structuredClone(s3);
    storage.object_store = {
      ...storage.object_store,
      endpoint: "https://objects.example.test",
      region: "garage",
      bucket: "b",
      force_path_style: true,
    };
    expect(objectStoreNamespace(storage)).toBe(
      new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(["https://objects.example.test", "garage", "b", true]))
        .digest("hex"),
    );
  });

  test("the process binding wins over a stored revision and cannot be written", () => {
    const stored = structuredClone(s3);
    bindProcessStorage(stored, local);
    expect(stored.backend).toBe("filesystem");
    expect(stored.filesystem.root).toBe("/data/files");
    expect(isBootstrapStoragePath("storage.backend")).toBe(true);
    expect(isBootstrapStoragePath("storage.filesystem.root")).toBe(true);
    expect(isBootstrapStoragePath("storage.object_store.bucket")).toBe(false);
  });

  test("preflight for filesystem mode checks the folder, not S3", async () => {
    const root = freshRoot();
    const storage = structuredClone(local);
    storage.filesystem.root = root;
    await preflightObjectStoreConfig(storage);
    expect(statSync(root).isDirectory()).toBe(true);
    storage.filesystem.root = "";
    await expect(preflightObjectStoreConfig(storage)).rejects.toThrow(FileSystemStoreError);
  });

  test("the engine picks the filesystem store from the bootstrap environment", async () => {
    const root = freshRoot();
    const folder = mkdtempSync(join(base, "cfg-"));
    try {
      await loadConfig({
        env: {
          DATABASE_URL: "postgres://localhost/test",
          NODE_ENV: "test",
          OBJECT_STORAGE_BACKEND: "filesystem",
          OBJECT_STORAGE_ROOT: root,
        },
        configPathOverride: join(folder, "subkit.config.json"),
      });
      resetObjectStoreForRuntimeConfig();
      const store = getObjectStore();
      expect(store).toBeInstanceOf(FileSystemObjectStore);
      await store.put("selected/key", Buffer.from("on disk"));
      expect(statSync(join(root, "selected", "key")).isFile()).toBe(true);
    } finally {
      _resetConfigForTests();
      resetObjectStoreForRuntimeConfig();
    }
    expect(getObjectStore()).toBeInstanceOf(MemoryObjectStore);
  });
});
