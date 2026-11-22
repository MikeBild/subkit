import { describe, expect, test } from "bun:test";
import { errorFields, formatLogLine, rotatedName, rotationPlan, tailLines } from "./app-log.ts";

const AT = "2026-11-22T10:00:00.000Z";
const SECRET = "Zx9ruJ7-pQ2vW4mN8sT1aB6c";

describe("log lines", () => {
  test("one line with time, level, event and fields", () => {
    expect(
      formatLogLine(
        {
          at: AT,
          level: "warn",
          event: "local.engine.exit",
          fields: { exit_code: 1, signal: null },
        },
        { secrets: [] },
      ),
    ).toBe(`${AT} WARN  local.engine.exit exit_code=1 signal=-`);
  });

  test("quotes values with spaces and folds newlines", () => {
    expect(
      formatLogLine(
        {
          at: AT,
          level: "info",
          event: "x",
          fields: { error: "bad\nthing here", skip: undefined },
        },
        { secrets: [] },
      ),
    ).toBe(`${AT} INFO  x error="bad thing here"`);
  });

  test("never writes known secrets, credentials, home paths or emails", () => {
    const line = formatLogLine(
      {
        at: AT,
        level: "error",
        event: "local.start",
        fields: {
          error: `postgres://subkit:${SECRET}@/postgres refused`,
          header: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk",
          password: "password=hunter2-hunter2",
          file: "/Users/mike/Library/Application Support/SubKit/x.json",
          mail: "mike@example.com",
        },
      },
      { secrets: [SECRET], homeDir: "/Users/mike" },
    );
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("/Users/mike");
    expect(line).not.toContain("mike@example.com");
  });

  test("bounds very long lines", () => {
    const line = formatLogLine(
      { at: AT, level: "info", event: "x", fields: { text: "a".repeat(5000) } },
      { secrets: [] },
    );
    expect(line.length).toBe(2000);
  });

  test("error fields carry name, message, code and the first frame", () => {
    const error = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    const fields = errorFields(error);
    expect(fields.error).toBe("Error: listen EADDRINUSE");
    expect(fields.error_code).toBe("EADDRINUSE");
    expect(typeof fields.frame).toBe("string");
    expect(errorFields("plain")).toEqual({ error: "plain" });
  });
});

describe("rotation", () => {
  const limits = { maxBytes: 100, keep: 3 };

  test("nothing rotates while the file has room", () => {
    expect(rotationPlan(0, 500, limits)).toEqual([]);
    expect(rotationPlan(60, 40, limits)).toEqual([]);
  });

  test("a full file shifts every generation and drops the oldest", () => {
    expect(rotationPlan(90, 20, limits)).toEqual([
      { from: "subkit.log.3", to: null },
      { from: "subkit.log.2", to: "subkit.log.3" },
      { from: "subkit.log.1", to: "subkit.log.2" },
      { from: "subkit.log", to: "subkit.log.1" },
    ]);
  });

  test("generation names", () => {
    expect(rotatedName(0)).toBe("subkit.log");
    expect(rotatedName(2)).toBe("subkit.log.2");
  });
});

describe("tail", () => {
  test("keeps the last lines across files, oldest first", () => {
    expect(tailLines(["a\nb\n", "c\nd\n"], 3)).toEqual(["b", "c", "d"]);
    expect(tailLines(["a\n"], 0)).toEqual([]);
  });
});

describe("field names used by the app", () => {
  test("keep their values", () => {
    const fields = {
      exit_code: 1,
      error_code: -6,
      signal: "SIGTERM",
      runner_state: "crashed",
      phase: "failed",
      event: "fail",
      pid: 4711,
      port: 47811,
      preferred_port: 47811,
      endpoint: "socket",
      process: "GPU",
      reason: "crashed",
      channel: "production",
      version: "12.1.2",
      kind: "database",
    };
    const line = formatLogLine({ at: AT, level: "info", event: "x", fields }, { secrets: [] });
    for (const [key, value] of Object.entries(fields)) expect(line).toContain(`${key}=${value}`);
  });
});
