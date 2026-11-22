import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLog } from "./app-log.ts";

const folder = mkdtempSync(join(tmpdir(), "subkit-log-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const SECRET = "kT3mQ8vX1zR5nB7wY2cF6hJ9pL4sD0gA_e-uVoIiZ";
const at = () => new Date("2026-11-22T10:00:00.000Z");

describe("app log file", () => {
  test("lines written before the folder opens land in the file", () => {
    const dir = join(folder, "early");
    const log = new AppLog(undefined, at);
    log.info("app.launch", { version: "12.1.2" });
    log.open(dir);
    log.warn("local.engine.exit", { exit_code: 1 });
    expect(log.tail(10)).toEqual([
      "2026-11-22T10:00:00.000Z INFO  app.launch version=12.1.2",
      "2026-11-22T10:00:00.000Z WARN  local.engine.exit exit_code=1",
    ]);
  });

  test("rotates at the size limit and keeps a bounded number of files", () => {
    const dir = join(folder, "rotate");
    const log = new AppLog({ maxBytes: 200, keep: 2 }, at);
    log.open(dir);
    for (let i = 0; i < 30; i++) log.info("tick", { i });
    expect(existsSync(join(dir, "subkit.log"))).toBe(true);
    expect(existsSync(join(dir, "subkit.log.1"))).toBe(true);
    expect(existsSync(join(dir, "subkit.log.2"))).toBe(true);
    expect(existsSync(join(dir, "subkit.log.3"))).toBe(false);
    expect(readFileSync(join(dir, "subkit.log"), "utf8").length).toBeLessThanOrEqual(200);
    expect(log.tail(1)).toEqual(["2026-11-22T10:00:00.000Z INFO  tick i=29"]);
  });

  test("secrets known before the line are never written", () => {
    const dir = join(folder, "secret");
    const log = new AppLog(undefined, at);
    log.open(dir);
    log.addSecret(SECRET);
    log.error("local.start", new Error(`launch secret ${SECRET} refused`));
    const text = readFileSync(join(dir, "subkit.log"), "utf8");
    expect(text).toContain("ERROR local.start");
    expect(text).not.toContain(SECRET);
  });
});
