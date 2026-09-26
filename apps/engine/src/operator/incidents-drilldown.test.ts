// The link under a number has to ask for what the number counted.
//
// `executions.incidents_24h` counts failed runs THE SCHEDULER STARTED — its
// own `definition` says it separates those from authoring trials. The link it
// carried asked only for `status=failed`. On a live installation that meant a
// tile reading "production incidents: 0" opened a list of 977 runs that were
// overwhelmingly trials: the reader was shown precisely the category the
// number excludes.
//
// Both halves are pinned here because the two halves fail differently. Drop
// `status` and the list is every run; drop `source` and the list is every
// failure, trials included. The cockpit reads both from the query string
// (`runs-filter.test.ts` holds that end), so this is the other side of one
// contract — a path this file blesses and the page ignores would leave the
// reader back at 977 rows with nothing red.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "operational-overview.ts"), "utf8");

/** The `path:` a metric block declares, read from the source of truth. */
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
  // They opened the identical URL, which is why one of them had to be read as
  // the other. Whatever each becomes, they must stay distinguishable.
  expect(pathOf("executions.incidents_24h")).not.toBe(pathOf("executions.trial_failures_24h"));
});

test("a 24-hour metric does not bake its window into the link", () => {
  // A cutoff written into a path keeps being served after the snapshot behind
  // it was recomputed, so the link would name a window the number no longer
  // used. Wider in time is visible; wrong is not.
  const path = pathOf("executions.incidents_24h");
  expect(path).not.toMatch(/since=|from=|after=/);
});
