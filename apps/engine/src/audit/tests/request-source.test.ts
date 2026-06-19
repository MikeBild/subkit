// Unit coverage for `readRequestSource` — the single helper every
// route uses to project the trace-middleware-set `request_source`
// onto audit metadata.
//
// Contract:
//   - Allowed canonical values pass through verbatim.
//   - Unknown / unexpected values (including future trace-middleware
//     additions wired before the canonical enum widens) return
//     `undefined` rather than throwing.
//   - Missing context variable returns `undefined`.
//
// The audit-metadata `.parse(...)` paths declare `request_source` as
// optional; the helper's `undefined` return therefore lets the parse
// succeed instead of aborting the request.

import { describe, expect, test } from "bun:test";
import type { Context } from "hono";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { readRequestSource } from "../request-source.ts";

function fakeContext(value: unknown): Context {
  return {
    get: (key: string) => (key === "request_source" ? value : undefined),
  } as unknown as Context;
}

describe("readRequestSource", () => {
  const canonical: RequestSource[] = [
    "api",
    "cli",
    "scheduler",
    "mcp",
    "webhook",
    "tool-chain",
    "ui",
    "chat",
  ];
  test.each(canonical.map((v) => [v] as const))("allows canonical value %s", (value) => {
    expect(readRequestSource(fakeContext(value))).toBe(value);
  });

  test("returns undefined for an unknown string", () => {
    expect(readRequestSource(fakeContext("totally-fake"))).toBeUndefined();
  });

  test("returns undefined when the context variable is missing", () => {
    expect(readRequestSource(fakeContext(undefined))).toBeUndefined();
  });

  test("returns undefined for non-string values", () => {
    expect(readRequestSource(fakeContext(42))).toBeUndefined();
    expect(readRequestSource(fakeContext(null))).toBeUndefined();
    expect(readRequestSource(fakeContext({}))).toBeUndefined();
  });
});
