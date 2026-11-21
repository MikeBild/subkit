import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markQuarantine, QUARANTINE_ATTRIBUTE, quarantineValue } from "./quarantine.ts";

const AT = Date.parse("2026-11-21T10:00:00Z");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("quarantine mark", () => {
  test("the value names SubKit and the time in hex seconds", () => {
    expect(quarantineValue(AT)).toBe(`0082;${(AT / 1000).toString(16)};SubKit;`);
  });

  test("marks a written file on macOS", async () => {
    if (process.platform !== "darwin") return;
    const dir = mkdtempSync(join(tmpdir(), "subkit-quarantine-"));
    dirs.push(dir);
    const path = join(dir, "report.txt");
    writeFileSync(path, "x");
    expect(await markQuarantine(path, AT)).toBe(true);
    const value = execFileSync("/usr/bin/xattr", ["-p", QUARANTINE_ATTRIBUTE, path]).toString();
    expect(value.trim()).toBe(quarantineValue(AT));
  });

  test("reports a missing file as not marked", async () => {
    expect(await markQuarantine("/nonexistent/subkit/file.txt", AT)).toBe(false);
  });
});
