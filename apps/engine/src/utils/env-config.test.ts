import { afterEach, describe, expect, test } from "bun:test";
import { envCsvOr, envIntOr } from "./env-config.ts";

const ENV_KEY_INT = "__SUBKIT_TEST_ENV_INT__";
const ENV_KEY_CSV = "__SUBKIT_TEST_ENV_CSV__";

afterEach(() => {
  delete process.env[ENV_KEY_INT];
  delete process.env[ENV_KEY_CSV];
});

describe("envIntOr", () => {
  test("returns default when env unset", () => {
    delete process.env[ENV_KEY_INT];
    expect(envIntOr(ENV_KEY_INT, 42)).toBe(42);
  });

  test("returns parsed integer when env set", () => {
    process.env[ENV_KEY_INT] = "999";
    expect(envIntOr(ENV_KEY_INT, 42)).toBe(999);
  });

  test("falls back to default on non-numeric value", () => {
    process.env[ENV_KEY_INT] = "not-a-number";
    expect(envIntOr(ENV_KEY_INT, 42)).toBe(42);
  });

  test("falls back to default on zero or negative", () => {
    process.env[ENV_KEY_INT] = "0";
    expect(envIntOr(ENV_KEY_INT, 42)).toBe(42);
    process.env[ENV_KEY_INT] = "-5";
    expect(envIntOr(ENV_KEY_INT, 42)).toBe(42);
  });

  test("floors decimals", () => {
    process.env[ENV_KEY_INT] = "100.9";
    expect(envIntOr(ENV_KEY_INT, 42)).toBe(100);
  });

  test("falls back to default on empty string", () => {
    process.env[ENV_KEY_INT] = "";
    expect(envIntOr(ENV_KEY_INT, 42)).toBe(42);
  });
});

describe("envCsvOr", () => {
  test("returns default when env unset", () => {
    delete process.env[ENV_KEY_CSV];
    expect(envCsvOr(ENV_KEY_CSV, ["a", "b"])).toEqual(["a", "b"]);
  });

  test("returns parsed CSV when env set", () => {
    process.env[ENV_KEY_CSV] = "x,y,z";
    expect(envCsvOr(ENV_KEY_CSV, ["a", "b"])).toEqual(["x", "y", "z"]);
  });

  test("trims whitespace and drops empty entries", () => {
    process.env[ENV_KEY_CSV] = "x ,, y ,z";
    expect(envCsvOr(ENV_KEY_CSV, ["a"])).toEqual(["x", "y", "z"]);
  });

  test("falls back to default when env is empty after trim", () => {
    process.env[ENV_KEY_CSV] = ",,,";
    expect(envCsvOr(ENV_KEY_CSV, ["a"])).toEqual(["a"]);
  });
});
