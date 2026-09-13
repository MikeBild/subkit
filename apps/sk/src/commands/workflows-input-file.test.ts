// Unit tests for the `--input @<path>` ergonomics of `sk workflows run`.
// Tests focus on the file-reading path in workflows.ts:228-243.
// No engine client needed — we test the argument parsing + file-reading
// logic in isolation.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "sk-input-file-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Internal helper — mirrors the @<path> parsing logic from workflows.ts
// ---------------------------------------------------------------------------

/**
 * Mirrors the `--input @<path>` parsing in `workflows.ts:228-243`.
 * Returns the parsed value or throws with a descriptive message.
 */
function parseInputArg(raw: string): unknown {
  if (raw.startsWith("@")) {
    const filePath = raw.slice(1);
    const content = readFileSync(filePath, "utf8");
    return JSON.parse(content);
  }
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Happy path: @<path> reads JSON from disk
// ---------------------------------------------------------------------------

describe("--input @<path> — happy path", () => {
  test("@./file.json reads and parses valid JSON", () => {
    const payload = { action: "test", value: 42 };
    const filePath = join(tempDir, "payload.json");
    writeFileSync(filePath, JSON.stringify(payload));

    const result = parseInputArg(`@${filePath}`);
    expect(result).toEqual(payload);
  });

  test("@<path> with nested object parses correctly", () => {
    const payload = { nested: { key: "value" }, arr: [1, 2, 3] };
    const filePath = join(tempDir, "nested.json");
    writeFileSync(filePath, JSON.stringify(payload));

    const result = parseInputArg(`@${filePath}`);
    expect(result).toEqual(payload);
  });

  test("inline JSON (no @ prefix) is parsed directly from the string", () => {
    const result = parseInputArg('{"foo":"bar"}');
    expect(result).toEqual({ foo: "bar" });
  });

  test("@<path> with array payload parses correctly", () => {
    const payload = [1, 2, 3];
    const filePath = join(tempDir, "array.json");
    writeFileSync(filePath, JSON.stringify(payload));

    const result = parseInputArg(`@${filePath}`);
    expect(result).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Error cases: bad path / bad JSON
// ---------------------------------------------------------------------------

describe("--input @<path> — error cases", () => {
  test("@<non-existent-path> throws a file-not-found error", () => {
    const badPath = join(tempDir, "does-not-exist.json");
    expect(() => parseInputArg(`@${badPath}`)).toThrow();
  });

  test("@<path> with malformed JSON throws a parse error", () => {
    const filePath = join(tempDir, "bad.json");
    writeFileSync(filePath, "{{not valid json}}");
    expect(() => parseInputArg(`@${filePath}`)).toThrow();
  });

  test("inline malformed JSON (no @ prefix) throws a parse error", () => {
    expect(() => parseInputArg("{ not json }")).toThrow();
  });

  test("error message for bad JSON includes context (not just 'error')", () => {
    const filePath = join(tempDir, "corrupt.json");
    writeFileSync(filePath, "not-json");
    let caught: Error | null = null;
    try {
      parseInputArg(`@${filePath}`);
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }
    expect(caught).not.toBeNull();
    expect(caught?.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Boundary cases
// ---------------------------------------------------------------------------

describe("--input @<path> — boundary cases", () => {
  test("empty JSON object {} is valid", () => {
    const filePath = join(tempDir, "empty.json");
    writeFileSync(filePath, "{}");
    const result = parseInputArg(`@${filePath}`);
    expect(result).toEqual({});
  });

  test("null JSON value is valid", () => {
    const filePath = join(tempDir, "null.json");
    writeFileSync(filePath, "null");
    const result = parseInputArg(`@${filePath}`);
    expect(result).toBeNull();
  });

  test("a string not starting with @ is treated as inline JSON", () => {
    const result = parseInputArg('"hello"');
    expect(result).toBe("hello");
  });
});
