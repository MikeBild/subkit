#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";
import { selectCoreTests } from "./audit/core-tests.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const candidates = [
  ...new Glob("apps/engine/src/**/*.test.ts").scanSync({ cwd: REPO, onlyFiles: true }),
  ...new Glob("packages/shared/src/**/*.test.ts").scanSync({ cwd: REPO, onlyFiles: true }),
];
const tests = selectCoreTests(candidates).map((p) => `./${p}`);

if (process.argv.includes("--list")) {
  console.log(tests.join("\n"));
  process.exit(0);
}
if (tests.length === 0) {
  console.error("no core tests found");
  process.exit(1);
}
const result = spawnSync("bun", ["test", ...tests, ...process.argv.slice(2)], {
  cwd: REPO,
  env: { ...process.env, SKIP_DOCKER: "1" },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
