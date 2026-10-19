import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPinnedBun } from "../check-bun-version.ts";

test("accepts the runtime pinned by the repository", () => {
  const expected = readFileSync(join(import.meta.dir, "..", "..", ".bun-version"), "utf8").trim();
  expect(() => assertPinnedBun(expected, expected)).not.toThrow();
});

test("rejects a mismatched runtime with an actionable error", () => {
  const expected = readFileSync(join(import.meta.dir, "..", "..", ".bun-version"), "utf8").trim();
  expect(() => assertPinnedBun("unsupported", expected)).toThrow(
    `Bun ${expected} is required by .bun-version; running unsupported. Select the pinned Bun before running validation.`,
  );
});
