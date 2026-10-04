import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "operational-overview.ts"), "utf8");

function pathOf(metricId: string): string {
  const block = SOURCE.split(`id: "${metricId}"`)[1];
  if (!block) throw new Error(`no metric block for ${metricId}`);
  const match = block.match(/path:\s*"([^"]+)"/);
  if (!match) throw new Error(`no path declared for ${metricId}`);
  return match[1] as string;
}

test("production incidents lead to failed SCHEDULED runs, not to every failure", () => {
  const path = pathOf("executions.incidents_24h");
  const query = new URLSearchParams(path.split("?")[1] ?? "");
  expect(query.get("status")).toBe("failed");
  expect(query.get("source")).toBe("scheduler");
});

test("the two failure counts do not lead to the same list", () => {
  expect(pathOf("executions.incidents_24h")).not.toBe(pathOf("executions.trial_failures_24h"));
});

test("a 24-hour metric does not bake its window into the link", () => {
  const path = pathOf("executions.incidents_24h");
  expect(path).not.toMatch(/since=|from=|after=/);
});
