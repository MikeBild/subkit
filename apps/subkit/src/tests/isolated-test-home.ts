import { randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readRegularFile } from "../lib/path-input.ts";

const prefix = "subkit-test-home-";
const marker = ".subkit-test-home-claim.json";
const consumedMarker = ".subkit-test-home-claimed.json";
const tempBase = realpathSync(tmpdir());
const ownedHomes = new Map<string, string>();

export type IsolatedTestHome = { path: string; token: string };

function record(token: string): string {
  return JSON.stringify({ base: tempBase, token });
}

function inspect(home: string, token: string, names: string[]): string | undefined {
  const absolute = resolve(home);
  let root: ReturnType<typeof lstatSync>;
  try {
    root = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    dirname(absolute) !== tempBase ||
    !basename(absolute).startsWith(prefix)
  ) {
    throw new Error(`refusing to use an unsafe test home: ${home}`);
  }
  for (const name of names) {
    const claim = readRegularFile(join(absolute, name), { followSymlinks: false });
    if (claim.kind === "file" && claim.bytes.toString("utf8") === record(token)) return absolute;
  }
  throw new Error(`refusing to use an unregistered test home: ${home}`);
}

export function createIsolatedTestHome(): IsolatedTestHome {
  const path = mkdtempSync(join(tempBase, prefix));
  const token = randomUUID();
  writeFileSync(join(path, marker), record(token), { mode: 0o600 });
  ownedHomes.set(path, token);
  return { path, token };
}

export function claimIsolatedTestHome(path: string, token: string): string {
  const absolute = inspect(path, token, [marker]);
  if (!absolute) throw new Error(`registered test home no longer exists: ${path}`);
  renameSync(join(absolute, marker), join(absolute, consumedMarker));
  return absolute;
}

export function removeIsolatedTestHome(home: IsolatedTestHome): void {
  if (ownedHomes.get(home.path) !== home.token) {
    throw new Error(`refusing to remove an unregistered test home: ${home.path}`);
  }
  const absolute = inspect(home.path, home.token, [marker, consumedMarker]);
  ownedHomes.delete(home.path);
  if (absolute) rmSync(absolute, { recursive: true, force: true });
}
