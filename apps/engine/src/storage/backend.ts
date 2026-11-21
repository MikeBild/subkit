import { createHash } from "node:crypto";
import type { Config } from "../config/schema.ts";

export type StorageConfig = Config["storage"];

export const FILESYSTEM_BUCKET = "local";

export const BOOTSTRAP_STORAGE_PATHS = ["storage.backend", "storage.filesystem.root"] as const;

export function isBootstrapStoragePath(path: string): boolean {
  return (BOOTSTRAP_STORAGE_PATHS as readonly string[]).includes(path);
}

export function bindProcessStorage(target: StorageConfig, process: StorageConfig): void {
  target.backend = process.backend;
  target.filesystem = { ...target.filesystem, root: process.filesystem.root };
}

export function filesystemRoot(storage: StorageConfig): string | null {
  return storage.backend === "filesystem" ? storage.filesystem.root : null;
}

export function objectStoreBucket(storage: StorageConfig): string {
  return storage.backend === "filesystem" ? FILESYSTEM_BUCKET : storage.object_store.bucket;
}

export function objectStoreNamespace(storage: StorageConfig): string {
  const identity =
    storage.backend === "filesystem"
      ? ["filesystem"]
      : [
          storage.object_store.endpoint,
          storage.object_store.region,
          storage.object_store.bucket,
          storage.object_store.force_path_style,
        ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
