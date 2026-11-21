import { describe, expect, test } from "bun:test";
import { setDeep } from "./walk.ts";

describe("setDeep", () => {
  test("creates missing objects and replaces arrays on the way", () => {
    const target: Record<string, unknown> = { llm: { providers: [] } };
    setDeep(target, ["llm", "providers", "openai", "api_key"], "k");
    expect(target).toEqual({ llm: { providers: { openai: { api_key: "k" } } } });
  });

  test.each(["__proto__", "prototype", "constructor"])("refuses the segment %s", (segment) => {
    const target: Record<string, unknown> = {};
    expect(() => setDeep(target, ["llm", "providers", segment, "polluted"], true)).toThrow(
      `config path segment "${segment}" is not allowed`,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
