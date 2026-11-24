import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

const root = join(import.meta.dir, "../..");

test("affected CI installs expect before running PTY tests", () => {
  const workflow = load(readFileSync(join(root, ".github/workflows/pr-check.yml"), "utf8")) as {
    jobs: { affected: { steps: { run?: string }[] } };
  };
  const commands = workflow.jobs.affected.steps.map((step) => step.run ?? "");
  const install = commands.findIndex((command) => /apt-get install.*\bexpect\b/.test(command));
  const tests = commands.findIndex((command) =>
    command.includes("bun scripts/test-files-isolated.ts"),
  );
  expect(install).toBeGreaterThanOrEqual(0);
  expect(install).toBeLessThan(tests);
});

test("intake stays within the production file size limit", () => {
  const source = readFileSync(join(root, "apps/engine/src/knowledge/intake.ts"), "utf8");
  expect(source.split("\n").length).toBeLessThanOrEqual(1000);
});
