import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("affected CI installs the PTY runtime before running CLI tests", () => {
  const workflow = readFileSync(
    join(import.meta.dir, "../../.github/workflows/pr-check.yml"),
    "utf8",
  );
  const job = workflow.slice(workflow.indexOf("\n  affected:\n"));
  const terminalTools = job.indexOf("sudo apt-get install -y expect");
  const build = job.indexOf("bun run build subkit --skip-deps");
  const tests = job.indexOf("bun scripts/test-files-isolated.ts");
  expect(terminalTools).toBeGreaterThan(-1);
  expect(build).toBeGreaterThan(terminalTools);
  expect(tests).toBeGreaterThan(build);
});
