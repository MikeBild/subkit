import { expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";

test("task run turn tests stay within the test file size budget", () => {
  const files = globSync("apps/engine/src/queue/handlers/task-run-turn*.test.ts");
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(readFileSync(file, "utf8").split("\n").length, file).toBeLessThanOrEqual(600);
  }
});
