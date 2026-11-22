#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LaunchOutcome {
  readonly alive: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export function launchProblem(outcome: LaunchOutcome): string | null {
  if (outcome.alive) return null;
  if (outcome.signal) return `the app was killed by ${outcome.signal} on launch`;
  if (outcome.code !== 0) return `the app exited with ${outcome.code} on launch`;
  return null;
}

function verifySignature(app: string): void {
  const result = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`${app} carries no valid code signature`);
}

function executable(app: string): string {
  const result = spawnSync(
    "plutil",
    ["-extract", "CFBundleExecutable", "raw", join(app, "Contents", "Info.plist")],
    { encoding: "utf8" },
  );
  const name = result.stdout.trim();
  if (result.status !== 0 || !name) throw new Error(`${app} names no executable`);
  return join(app, "Contents", "MacOS", name);
}

async function launch(app: string, seconds: number): Promise<LaunchOutcome> {
  const profile = mkdtempSync(join(tmpdir(), "subkit-smoke-"));
  const child = spawn(executable(app), [`--user-data-dir=${profile}`], { stdio: "ignore" });
  const exited = new Promise<LaunchOutcome>((resolve) =>
    child.once("exit", (code, signal) => resolve({ alive: false, code, signal })),
  );
  const timer = new Promise<LaunchOutcome>((resolve) =>
    setTimeout(() => resolve({ alive: true, code: null, signal: null }), seconds * 1000),
  );
  const outcome = await Promise.race([exited, timer]);
  if (outcome.alive) {
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(killer);
  }
  rmSync(profile, { recursive: true, force: true });
  return outcome;
}

export async function verifyMacApp(app: string, seconds = 8): Promise<void> {
  verifySignature(app);
  const problem = launchProblem(await launch(app, seconds));
  if (problem) throw new Error(`${app}: ${problem}`);
  console.log(`${app} is signed and stays up for ${seconds} seconds`);
}

if (import.meta.main) {
  const app = process.argv[2];
  if (!app) {
    console.error("usage: bun scripts/verify-mac-app.ts <path/to/App.app>");
    process.exit(2);
  }
  try {
    await verifyMacApp(app);
  } catch (error) {
    console.error(`verify-mac-app: ${(error as Error).message}`);
    process.exit(1);
  }
}
