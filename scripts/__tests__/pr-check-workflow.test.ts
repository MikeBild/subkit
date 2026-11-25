import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(
  join(import.meta.dir, "../../.github/workflows/pr-check.yml"),
  "utf8",
);
const affected = workflow.slice(workflow.indexOf("\n  affected:"));

test("the changed source coverage floor includes renamed files", () => {
  const selection = affected.match(/changed=\$\(git diff[^\n]+/)?.[0];
  expect(selection).toBeDefined();
  const statuses = selection?.match(/--diff-filter=([A-Z]+)/)?.[1];
  expect(statuses).toContain("A");
  expect(statuses).toContain("M");
  expect(statuses).toContain("R");
});

test("affected runners install expect before executing PTY tests", () => {
  const install = affected.indexOf("sudo apt-get install -y expect");
  expect(install).toBeGreaterThan(-1);
  expect(install).toBeLessThan(affected.indexOf("bun scripts/test-files-isolated.ts"));
});

test("the base comparison builds the CLI before executing the same PTY tests", () => {
  const setup = affected.slice(
    affected.indexOf("(cd ../base && bun install"),
    affected.indexOf("new=0"),
  );
  expect(setup).toContain("bun run build assets");
  expect(setup).toContain("bun run build subkit --skip-deps");
});
