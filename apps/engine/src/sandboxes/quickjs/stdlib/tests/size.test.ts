import { describe, expect, test } from "bun:test";
import { STDLIB_CORE_SOURCE, STDLIB_HELPER_SOURCES, STDLIB_SOURCE } from "../index.ts";

const SIZE_CEILING_BYTES = 20_000;

describe("sandbox core size budget", () => {
  test(`evaluated source length stays under ${SIZE_CEILING_BYTES} bytes`, () => {
    expect(STDLIB_CORE_SOURCE.length).toBeLessThan(SIZE_CEILING_BYTES);
    expect(Object.keys(STDLIB_HELPER_SOURCES)).toHaveLength(9);
    expect(
      Math.max(...Object.values(STDLIB_HELPER_SOURCES).map((source) => source.length)),
    ).toBeLessThan(1_000_000);
  });

  test("generated core remains parseable", () => {
    expect(() => new Function(STDLIB_SOURCE)).not.toThrow();
  });
});
