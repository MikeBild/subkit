import { expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";

test("connector recipe tests stay within the test file size budget", () => {
  const files = globSync("apps/engine/src/connectors/recipes*.test.ts");
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(readFileSync(file, "utf8").split("\n").length, file).toBeLessThanOrEqual(600);
  }
});
