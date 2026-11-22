import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gateFor, plan } from "../lib/commands.ts";

const root = join(import.meta.dir, "../..");
const tagRelease = readFileSync(join(root, "scripts/tag-release.ts"), "utf8");
const qualityWorkflow = readFileSync(join(root, ".github/workflows/quality.yml"), "utf8");
const prePush = readFileSync(join(root, ".githooks/pre-push"), "utf8");
const CTX = { version: "1.2.3", platform: "linux" };

const ids = (profile: Parameters<typeof gateFor>[0]) => gateFor(profile).map((check) => check.id);

test("developer and release gates keep their distinct quality contracts", () => {
  expect(ids("static")).toContain("determinism");
  expect(ids("static")).not.toContain("mutation");
  expect(ids("static")).not.toContain("coverage");
  expect(ids("full")).toEqual(expect.arrayContaining([...ids("static"), "coverage", "mutation"]));
  expect(ids("release")).toEqual([
    "mutation-evidence",
    ...ids("static"),
    "coverage",
    "docker",
    "smoke",
  ]);
  expect(ids("release")).not.toContain("mutation");
  const evidence = plan("quality", ["release", "--check"], CTX);
  expect(evidence.ok && evidence.steps.map((step) => step.argv.join(" "))).toEqual([
    "bun scripts/release-mutation-evidence.ts check",
  ]);
  const run = plan("quality", ["release"], CTX);
  expect(run.ok && run.steps.at(-1)?.argv.join(" ")).toBe(
    "bun scripts/release-mutation-evidence.ts run",
  );
});

test("pre-push runs the push profile of the same gate list", () => {
  expect(prePush).toContain("bun run verify push");
  expect(ids("push")).toEqual(
    expect.arrayContaining(["lint", "typecheck", "determinism", "build"]),
  );
  for (const id of ids("push")) expect(prePush).not.toContain(`bun run ${id}`);
});

test("tagging checks the mutation evidence before the paid check and never runs mutation itself", () => {
  const evidence = tagRelease.indexOf('["run", "quality", "release", "--check"]');
  const paid = tagRelease.indexOf('["run", "verify", "llm-live"');
  const gate = tagRelease.indexOf('["run", "verify", "release", ...(mutation === "deferred"');
  expect(evidence).toBeGreaterThan(-1);
  expect(paid).toBeGreaterThan(evidence);
  expect(gate).toBeGreaterThan(paid);
  expect(tagRelease).not.toContain('["run", "quality", "release"]');
  expect(tagRelease).not.toContain('["run", "verify", "full"]');
});

test("quality CI runs the suite with global coverage once and keeps mutation out of the push path", () => {
  const job = qualityWorkflow.slice(qualityWorkflow.indexOf("  coverage:\n"));
  const install = job.indexOf("bun install --frozen-lockfile");
  const terminalTools = job.indexOf("sudo apt-get install -y expect");
  const assets = job.indexOf("bun run build assets");
  const subkit = job.indexOf("bun run build subkit --skip-deps");
  const coverage = job.indexOf("bun run quality coverage");
  const evidence = job.indexOf("name: coverage-floor-evidence");
  expect(install).toBeGreaterThan(-1);
  expect(terminalTools).toBeGreaterThan(install);
  expect(assets).toBeGreaterThan(terminalTools);
  expect(subkit).toBeGreaterThan(assets);
  expect(coverage).toBeGreaterThan(subkit);
  expect(evidence).toBeGreaterThan(coverage);
  expect(qualityWorkflow).toContain("retention-days: 90");
  expect(qualityWorkflow).toContain("retention-days: 30");
  expect(qualityWorkflow).toContain("path: .reports/coverage/");
  const jobs = qualityWorkflow.slice(qualityWorkflow.indexOf("\njobs:\n"));
  expect(jobs.match(/^ {2}[a-z-]+:$/gm)).toEqual(["  coverage:"]);
  expect(qualityWorkflow).not.toContain("matrix");
  expect(qualityWorkflow).not.toContain("distributed-quality.ts");
  expect(qualityWorkflow).not.toContain("stryker");
  expect(qualityWorkflow).not.toContain("pull_request");
});
