import { describe, expect, test } from "bun:test";
import { VERSION } from "../version.ts";

describe("VERSION", () => {
  test("is a string", () => {
    expect(typeof VERSION).toBe("string");
  });

  test("equals '0.0.0-dev' in development mode", () => {
    expect(VERSION).toBe("0.0.0-dev");
  });

  test("matches semver-like format", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-\w+)?$/);
  });
});
