#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const REPO = join(APP, "..", "..");

export interface PackageOptions {
  readonly dev: boolean;
  readonly dir: boolean;
  readonly prebuilt: boolean;
  readonly builder: readonly string[];
}

export interface PackageStep {
  readonly argv: readonly string[];
  readonly cwd: "app" | "repo";
}

export function parsePackageArgs(argv: readonly string[]): PackageOptions {
  const own = new Set(["--dev", "--dir", "--prebuilt"]);
  return {
    dev: argv.includes("--dev"),
    dir: argv.includes("--dir"),
    prebuilt: argv.includes("--prebuilt"),
    builder: argv.filter((arg) => !own.has(arg) && arg !== "--"),
  };
}

export function packageSteps(options: PackageOptions): PackageStep[] {
  const stage: PackageStep[] = options.prebuilt
    ? []
    : [
        { argv: ["bun", "scripts/fetch-agent-desktop.ts"], cwd: "app" },
        { argv: ["bun", "scripts/fetch-agent-browser.ts"], cwd: "app" },
        { argv: ["bun", "run", "build", "desktop-engine"], cwd: "repo" },
        { argv: ["bun", "scripts/fetch-postgres.ts", "--target", "darwin-arm64"], cwd: "app" },
      ];
  return [
    ...stage,
    { argv: ["bun", "scripts/build.ts", ...(options.dev ? [] : ["--production"])], cwd: "app" },
    { argv: ["bun", "scripts/notices.ts"], cwd: "app" },
    {
      argv: [
        "bunx",
        "electron-builder",
        "--config",
        options.dev ? "electron-builder.dev.yml" : "electron-builder.yml",
        ...(options.dev || options.dir ? ["--dir"] : []),
        ...options.builder,
      ],
      cwd: "app",
    },
  ];
}

if (import.meta.main) {
  for (const step of packageSteps(parsePackageArgs(process.argv.slice(2)))) {
    const [command, ...args] = step.argv;
    const result = spawnSync(command ?? "", args, {
      cwd: step.cwd === "app" ? APP : REPO,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error(`package: ${step.argv.join(" ")} failed`);
      process.exit(result.status ?? 1);
    }
  }
}
