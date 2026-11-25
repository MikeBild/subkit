import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

test("the affected CI runner installs expect before running PTY tests", () => {
  const workflow = load(
    readFileSync(new URL("../../../../.github/workflows/pr-check.yml", import.meta.url), "utf8"),
  ) as { jobs: { affected: { steps: Array<{ run?: string }> } } };
  const commands = workflow.jobs.affected.steps.map((step) => step.run ?? "");
  const install = commands.findIndex((command) => /apt-get install.*\bexpect\b/.test(command));
  const tests = commands.findIndex((command) => command.includes("test-files-isolated.ts"));
  expect(install).toBeGreaterThanOrEqual(0);
  expect(install).toBeLessThan(tests);
});
