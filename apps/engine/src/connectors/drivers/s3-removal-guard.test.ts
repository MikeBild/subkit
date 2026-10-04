import { expect, test } from "bun:test";
import { assertRemovableObject } from "./s3.ts";

test("an object key with no body is removable", () => {
  expect(() => assertRemovableObject("v1/sources/2026-01-01/a.json", undefined)).not.toThrow();
  expect(() => assertRemovableObject("v1/sources/2026-01-01/a.json", null)).not.toThrow();
});

test("a body is refused — there is no bulk-delete shape", () => {
  expect(() => assertRemovableObject("v1/sources/a.json", '{"items":["a","b"]}')).toThrow(
    "does not accept a body",
  );
});

test("a folder prefix is not an object key", () => {
  expect(() => assertRemovableObject("v1/sources/", undefined)).toThrow("folder prefix");
  expect(() => assertRemovableObject("", undefined)).toThrow("folder prefix");
});
