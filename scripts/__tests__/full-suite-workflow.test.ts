import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = readFileSync(
  join(import.meta.dir, "../../.github/workflows/full-suite.yml"),
  "utf8",
);
const report = workflow.slice(workflow.indexOf("      - name: Open or update"));
const script = report.split("        run: |\n")[1].replace(/^ {10}/gm, "");

for (const scenario of [
  { name: "discovery failure", output: "", status: 1, succeeds: false },
  {
    name: "discovery failure after partial output",
    output: "scripts/example.test.ts\n",
    status: 1,
    succeeds: false,
  },
  { name: "empty discovery", output: "", status: 0, succeeds: false },
  { name: "no matching tests", output: "No tests found\n", status: 0, succeeds: false },
  {
    name: "successful discovery",
    output: "scripts/example.test.ts\n",
    status: 0,
    succeeds: true,
  },
]) {
  test(`nightly shard handles ${scenario.name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "full-suite-shard-"));
    try {
      writeFileSync(
        join(dir, "bun"),
        '#!/bin/sh\ncase " $* " in\n*" --list "*) printf "%s" "$DISCOVERY_OUTPUT"; exit "$DISCOVERY_STATUS" ;;\nesac\necho "$*" >> "$TEST_LOG"\n',
        { mode: 0o755 },
      );
      const shardScript = workflow
        .split("        run: |\n")[1]
        .split("      - name:")[0]
        .replace(/^ {10}/gm, "");
      const result = spawnSync("bash", ["-e", "-c", shardScript], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          SHARD: "1",
          DISCOVERY_OUTPUT: scenario.output,
          DISCOVERY_STATUS: String(scenario.status),
          TEST_LOG: join(dir, "tests.log"),
        },
        encoding: "utf8",
      });
      expect(result.status === 0).toBe(scenario.succeeds);
      if (scenario.succeeds) {
        expect(readFileSync(join(dir, "tests.log"), "utf8")).toContain("scripts/example.test.ts");
        expect(readFileSync(join(dir, "failed-1.txt"), "utf8")).toBe("");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  { name: "no shard results", shards: 0, result: "failure", closes: false },
  { name: "missing shard results", shards: 7, result: "success", closes: false },
  { name: "failed shard execution", shards: 8, result: "failure", closes: false },
  { name: "cancelled shard execution", shards: 8, result: "cancelled", closes: false },
  { name: "all eight successful shards", shards: 8, result: "success", closes: true },
]) {
  test(`nightly report handles ${scenario.name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "full-suite-report-"));
    try {
      writeFileSync(
        join(dir, "gh"),
        '#!/bin/sh\necho "$*" >> "$GH_LOG"\nif [ "$2" = list ]; then echo 123; fi\n',
        { mode: 0o755 },
      );
      for (let shard = 1; shard <= scenario.shards; shard++) {
        mkdirSync(join(dir, `failed/failed-${shard}`), { recursive: true });
        writeFileSync(join(dir, `failed/failed-${shard}/failed-${shard}.txt`), "");
      }
      const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_LOG: join(dir, "gh.log"),
          GITHUB_REPOSITORY: "test/subkit",
          RUN_URL: "https://example.com/run",
          SUITE_RESULT: scenario.result,
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const calls = readFileSync(join(dir, "gh.log"), "utf8");
      expect(calls.includes("issue close")).toBe(scenario.closes);
      expect(calls.includes("issue comment")).toBe(!scenario.closes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("nightly report receives the aggregate shard execution result", () => {
  expect(report).toContain(`SUITE_RESULT: $${"{{ needs.suite.result }}"}`);
});
