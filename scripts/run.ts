#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { plan, type Step } from "./lib/commands.ts";

const REPO = join(import.meta.dir, "..");

function version(): string {
  if (process.env.ENGINE_VERSION) return process.env.ENGINE_VERSION;
  return (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string })
    .version;
}

function run(step: Step): number {
  const out = step.stdout ? openSync(join(REPO, step.stdout), "w") : "inherit";
  try {
    const [command, ...args] = step.argv;
    const result = spawnSync(command ?? "", args, {
      cwd: step.cwd ? join(REPO, step.cwd) : REPO,
      env: { ...process.env, ...step.env },
      stdio: ["inherit", out, "inherit"],
    });
    if (result.error) {
      console.error(`[${step.label}] ${result.error.message}`);
      return 1;
    }
    return result.status ?? 1;
  } finally {
    if (typeof out === "number") closeSync(out);
  }
}

const [concern = "", ...argv] = process.argv.slice(2);
const result = plan(concern, argv, { version: version(), platform: process.platform });
if (!result.ok) {
  console.error(result.usage);
  process.exit(2);
}
const total = result.steps.length;
for (const [index, step] of result.steps.entries()) {
  if (total > 1) console.error(`[${concern} ${index + 1}/${total}] ${step.label}`);
  const status = run(step);
  if (status !== 0) {
    console.error(`[${concern}] ${step.label} failed (exit ${status})`);
    process.exit(status);
  }
}
