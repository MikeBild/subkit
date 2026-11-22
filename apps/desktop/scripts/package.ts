#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  localBundle,
  type PlatformCapabilities,
  platformCapabilities,
  supports,
} from "../src/shared/platform-capabilities.ts";

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

const BUILDER_PLATFORMS = [
  ["--mac", "darwin", "arm64"],
  ["--win", "win32", "x64"],
  ["--linux", "linux", "x64"],
] as const;

export function packagePlatform(
  options: PackageOptions,
  host: { platform: string; arch: string },
): PlatformCapabilities {
  const named = BUILDER_PLATFORMS.find(([flag]) => options.builder.includes(flag));
  return named
    ? platformCapabilities(named[1], named[2])
    : platformCapabilities(host.platform, host.arch);
}

function stageSteps(platform: PlatformCapabilities): PackageStep[] {
  const bundle = localBundle(platform);
  return [
    ...(supports(platform, "computer")
      ? [{ argv: ["bun", "scripts/fetch-agent-desktop.ts"], cwd: "app" } as const]
      : []),
    ...(supports(platform, "browser")
      ? [{ argv: ["bun", "scripts/fetch-agent-browser.ts"], cwd: "app" } as const]
      : []),
    ...(bundle && platform.platform
      ? [
          {
            argv: [
              "bun",
              "run",
              "build",
              "desktop-engine",
              "--target",
              ENGINE_TARGET[platform.platform],
            ],
            cwd: "repo",
          } as const,
          {
            argv: ["bun", "scripts/fetch-postgres.ts", "--target", bundle.postgres],
            cwd: "app",
          } as const,
        ]
      : []),
  ];
}

const ENGINE_TARGET = { "darwin-arm64": "darwin-arm64", "win32-x64": "windows-x64" } as const;

export function packageSteps(
  options: PackageOptions,
  host: { platform: string; arch: string } = process,
): PackageStep[] {
  const stage = options.prebuilt ? [] : stageSteps(packagePlatform(options, host));
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
