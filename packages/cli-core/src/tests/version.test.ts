import { describe, expect, test } from "bun:test";
import { VERSION } from "../version.ts";

describe("VERSION", () => {
  test("is a string", () => {
    expect(typeof VERSION).toBe("string");
  });

  test("equals '0.0.0-dev' in development mode", () => {
    // When running via `bun test` (not compiled), BUILD_VERSION is not defined
    // so VERSION falls back to "0.0.0-dev"
    expect(VERSION).toBe("0.0.0-dev");
  });

  test("matches semver-like format", () => {
    // Should be either "0.0.0-dev" or a semver like "1.2.3"
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-\w+)?$/);
  });
});
