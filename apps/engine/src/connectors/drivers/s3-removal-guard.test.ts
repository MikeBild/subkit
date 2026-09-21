// S3 answers 204 to a DELETE whether or not the key existed. A removal aimed at
// a folder prefix, or one that carries its keys in a body the driver never
// reads, therefore "succeeds" while deleting nothing — and a retention workflow
// built that way reports a plausible count forever. The driver refuses both.

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
