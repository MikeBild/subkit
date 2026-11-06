import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const names = ["LICENSE", "THIRD_PARTY_NOTICES.txt"] as const;
type ReleaseNotices = Partial<Record<(typeof names)[number], Buffer>>;

export async function downloadReleaseNotices(
  assets: Array<{ name: string; url: string }>,
  checksum: (name: string) => string | null,
  fetchImpl: typeof fetch,
): Promise<ReleaseNotices> {
  const notices: ReleaseNotices = {};
  for (const name of names) {
    const matches = assets.filter((asset) => asset.name === name);
    const expected = checksum(name);
    if (matches.length !== 1 || !expected)
      throw new Error(`Missing or ambiguous signed notice: ${name}`);
    const response = await fetchImpl(matches[0]!.url);
    if (!response.ok) throw new Error(`Failed to download notice: ${name}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error(`Notice checksum mismatch: ${name}`);
    notices[name] = bytes;
  }
  return notices;
}

export function retainReleaseNotices(execPath: string, directory: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const name of names) {
    const source = join(dirname(execPath), `subkit.${name}`);
    if (!existsSync(source)) continue;
    const bytes = readFileSync(source);
    writeFileSync(join(directory, name), bytes, { mode: 0o644 });
    hashes[name] = createHash("sha256").update(bytes).digest("hex");
  }
  return hashes;
}

export function readRetainedNotices(
  directory: string,
  hashes: Record<string, string> = {},
): ReleaseNotices {
  const notices: ReleaseNotices = {};
  for (const name of names) {
    if (!hashes[name]) continue;
    const bytes = readFileSync(join(directory, name));
    if (createHash("sha256").update(bytes).digest("hex") !== hashes[name])
      throw new Error(`Retained notice failed integrity check: ${name}`);
    notices[name] = bytes;
  }
  return notices;
}

export function replaceWithNotices(
  execPath: string,
  notices: ReleaseNotices,
  replaceBinary: () => void,
): void {
  const directory = dirname(execPath);
  const staging = mkdtempSync(join(directory, ".subkit-notices-"));
  const moved: string[] = [];
  const installed: string[] = [];
  let cleanup = true;
  try {
    mkdirSync(join(staging, "old"));
    for (const name of names) {
      if (!notices[name]) continue;
      const target = join(directory, `subkit.${name}`);
      if (existsSync(target) && lstatSync(target).isDirectory())
        throw new Error(`Notice installation target is a directory: ${name}`);
      writeFileSync(join(staging, name), notices[name]!, { mode: 0o644 });
    }
    for (const name of names) {
      if (!notices[name]) continue;
      const target = join(directory, `subkit.${name}`);
      if (existsSync(target)) {
        renameSync(target, join(staging, "old", name));
        moved.push(name);
      }
      renameSync(join(staging, name), target);
      installed.push(name);
    }
    replaceBinary();
  } catch (error) {
    cleanup = false;
    for (const name of installed.reverse()) rmSync(join(directory, `subkit.${name}`));
    for (const name of moved.reverse())
      renameSync(join(staging, "old", name), join(directory, `subkit.${name}`));
    cleanup = true;
    throw error;
  } finally {
    if (cleanup) rmSync(staging, { recursive: true, force: true });
  }
}
