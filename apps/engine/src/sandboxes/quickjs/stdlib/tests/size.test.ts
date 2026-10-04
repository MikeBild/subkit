import { describe, expect, test } from "bun:test";
import { STDLIB_SOURCE } from "../index.ts";

const SIZE_CEILING_BYTES = 30_000;

describe("stdlib.js size budget", () => {
  test(`evaluated source length stays under ${SIZE_CEILING_BYTES} bytes`, () => {
    expect(STDLIB_SOURCE.length).toBeLessThan(SIZE_CEILING_BYTES);
  });

  test("the comment strip left a parseable program (no template-literal casualties)", () => {
    expect(() => new Function(STDLIB_SOURCE)).not.toThrow();
  });
});
