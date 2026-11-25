import { describe, expect, test } from "bun:test";
import { INTAKE_FILE_BODY_MAX_CHARS, intakeFileBody } from "../../knowledge/intake-file.ts";
import { PatchItemSchema } from "./intake-representation.ts";

describe("PatchItemSchema", () => {
  test("accepts a one-character correction to a file body beyond two million characters", () => {
    const body = intakeFileBody(
      { filename: "large.txt", content_type: "text/plain", size_bytes: 2_030_003 },
      `${"a".repeat(2_030_000)}END`,
    );
    const patch = { expected_version: 1, body: `${body.slice(0, -1)}!` };

    expect(PatchItemSchema.parse(patch)).toEqual(patch);
  });

  test("accepts a body as long as the largest file body and rejects a longer one", () => {
    const longest = "a".repeat(INTAKE_FILE_BODY_MAX_CHARS);
    expect(PatchItemSchema.safeParse({ expected_version: 1, body: longest }).success).toBe(true);
    expect(PatchItemSchema.safeParse({ expected_version: 1, body: `${longest}a` }).success).toBe(
      false,
    );
  });

  test("rejects an empty body", () => {
    expect(PatchItemSchema.safeParse({ expected_version: 1, body: "" }).success).toBe(false);
  });
});
