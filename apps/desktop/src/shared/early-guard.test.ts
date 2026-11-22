import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { earlyLogFile, earlyLogFolder, earlyLogLine, installEarlyGuard } from "./early-guard.ts";

const AT = new Date("2026-11-22T10:00:00.000Z");

describe("early log location", () => {
  test("matches the app log folder on each platform", () => {
    expect(earlyLogFolder("darwin", {}, "/Users/mike")).toBe("/Users/mike/Library/Logs/SubKit");
    expect(
      earlyLogFolder("win32", { APPDATA: "C:\\Users\\mike\\AppData\\Roaming" }, "C:\\Users\\mike"),
    ).toBe("C:\\Users\\mike\\AppData\\Roaming\\SubKit\\logs");
    expect(earlyLogFolder("linux", {}, "/home/mike")).toBe("/home/mike/.config/SubKit/logs");
    expect(earlyLogFile("/Users/mike/Library/Logs/SubKit", "darwin")).toBe(
      "/Users/mike/Library/Logs/SubKit/subkit.log",
    );
  });

  test("the line names the error and redacts home paths and secrets", () => {
    const line = earlyLogLine(
      "main.early_uncaught",
      new Error("Cannot find module '/Users/mike/x.js' token=abcdef1234567890"),
      AT,
      "/Users/mike",
    );
    expect(line.startsWith("2026-11-22T10:00:00.000Z ERROR main.early_uncaught error=")).toBe(true);
    expect(line).not.toContain("/Users/mike");
    expect(line).not.toContain("abcdef1234567890");
  });
});

describe("early guard", () => {
  function ports() {
    const emitter = new EventEmitter();
    const lines: string[] = [];
    const fatal: unknown[] = [];
    const release = installEarlyGuard({
      on: (event, listener) => emitter.on(event, listener),
      off: (event, listener) => emitter.off(event, listener),
      write: (line) => lines.push(line),
      fatal: (error) => fatal.push(error),
      now: () => AT,
      home: "/Users/mike",
    });
    return { emitter, lines, fatal, release };
  }

  test("writes every exception and shows the failure once", () => {
    const { emitter, lines, fatal } = ports();
    emitter.emit("uncaughtException", new Error("first"));
    emitter.emit("uncaughtException", new Error("second"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Error: first");
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(fatal).toHaveLength(1);
  });

  test("a failing write still shows the failure", () => {
    const emitter = new EventEmitter();
    const fatal: unknown[] = [];
    installEarlyGuard({
      on: (event, listener) => emitter.on(event, listener),
      off: (event, listener) => emitter.off(event, listener),
      write: () => {
        throw new Error("read-only");
      },
      fatal: (error) => fatal.push(error),
      now: () => AT,
      home: "/",
    });
    emitter.emit("uncaughtException", new Error("boom"));
    expect(fatal).toHaveLength(1);
  });

  test("steps aside once the app log takes over", () => {
    const { emitter, lines, release } = ports();
    release();
    expect(emitter.listenerCount("uncaughtException")).toBe(0);
    expect(lines).toEqual([]);
  });
});
