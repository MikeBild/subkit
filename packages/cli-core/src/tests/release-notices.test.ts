import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRetainedNotices,
  replaceWithNotices,
  retainReleaseNotices,
} from "../release-notices.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "release-notices-"));
  directories.push(directory);
  const binary = join(directory, "subkit");
  writeFileSync(binary, "old binary");
  writeFileSync(join(directory, "subkit.LICENSE"), "old license");
  writeFileSync(join(directory, "subkit.THIRD_PARTY_NOTICES.txt"), "old notices");
  return { directory, binary };
}

test("restores both notices when binary replacement fails", () => {
  const { directory, binary } = fixture();
  expect(() =>
    replaceWithNotices(
      binary,
      {
        LICENSE: Buffer.from("new license"),
        "THIRD_PARTY_NOTICES.txt": Buffer.from("new notices"),
      },
      () => {
        throw new Error("replacement failed");
      },
    ),
  ).toThrow("replacement failed");
  expect(readFileSync(join(directory, "subkit.LICENSE"), "utf8")).toBe("old license");
  expect(readFileSync(join(directory, "subkit.THIRD_PARTY_NOTICES.txt"), "utf8")).toBe(
    "old notices",
  );
  expect(readFileSync(binary, "utf8")).toBe("old binary");
  expect(readdirSync(directory).sort()).toEqual([
    "subkit",
    "subkit.LICENSE",
    "subkit.THIRD_PARTY_NOTICES.txt",
  ]);
});

test("rejects altered retained notices before returning rollback contents", () => {
  const { directory, binary } = fixture();
  const retained = mkdtempSync(join(tmpdir(), "retained-notices-"));
  directories.push(retained);
  const hashes = retainReleaseNotices(binary, retained);
  expect(readRetainedNotices(retained, hashes).LICENSE?.toString()).toBe("old license");
  writeFileSync(join(retained, "LICENSE"), "tampered");
  expect(() => readRetainedNotices(retained, hashes)).toThrow("integrity check");
  expect(readFileSync(join(directory, "subkit.LICENSE"), "utf8")).toBe("old license");
});
