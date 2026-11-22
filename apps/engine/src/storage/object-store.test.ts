import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemObjectStore } from "./file-system-object-store.ts";
import { MemoryObjectStore } from "./object-store.ts";
import { objectStoreContract } from "./object-store-contract-fixtures.ts";

const memory = new MemoryObjectStore();
objectStoreContract("memory", { store: () => memory });

const root = mkdtempSync(join(tmpdir(), "subkit-fs-contract-"));
const filesystem = new FileSystemObjectStore(join(root, "files"));
objectStoreContract("filesystem", { store: () => filesystem });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
