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

describe("RequestSource ⇄ RequestSourceSchema lockstep", () => {
  test("execution/types RequestSource equals the canonical schema members", async () => {
    const { RequestSourceSchema } = await import("../../observability/service-metadata.ts");
    type FromExecution = import("../../execution/types.ts").RequestSource;
    const table = {
      api: true,
      cli: true,
      scheduler: true,
      mcp: true,
      webhook: true,
      "tool-chain": true,
      ui: true,
      chat: true,
      queue: true,
    } satisfies Record<FromExecution, true>;
    expect(new Set(Object.keys(table))).toEqual(new Set(RequestSourceSchema.options));
  });
});
