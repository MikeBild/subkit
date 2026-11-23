import { homedir } from "node:os";
import {
  CLI_BINARY,
  defaultUpdaterConfig,
  type EngineReleaseProbe,
  engineRelease,
  latestRelease,
  listRetainedVersions,
  performUpdate,
  rollbackTo,
  type UpdateInfo,
  type UpdaterConfig,
  updateAction,
  VERSION,
} from "@cli-core/index.ts";
import { runsAsCompiledBinary } from "@cli-core/release/update-policy.ts";
import { defineCommand } from "citty";
import { z } from "zod";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";
import { migrateLegacyAgentHookFiles } from "./agent-hook-config.ts";

const RollbackTargetSchema = z
  .string()
  .min(1, "--to= must not be empty")
  .regex(/^[A-Za-z0-9._+-]+$/, "--to= must be a version number");

function say(line: string): void {
  process.stdout.write(`${CLI_BINARY}: ${line}\n`);
}

function fail(line: string, code: number): never {
  process.stderr.write(`${CLI_BINARY}: ${line}\n`);
  process.exit(code);
}

function activeEngine(): EngineReleaseProbe {
  let client: EngineClient;
  try {
    const profile = resolveProfile();
    client = new EngineClient({
      engine_url: profile.engine_url,
      api_key: profile.api_key,
      tenant: profile.active_tenant_id,
    });
  } catch {
    return fail("no active profile — run `subkit login` first", 2);
  }
  return {
    installBase: `${client.base}/install`,
    version: async () => (await client.health()).version,
    hasInstallBundle: () => client.hasInstallBundle(),
  };
}

export const updateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Update the subkit CLI to the latest release, or to the version of your engine",
  },
  args: {
    check: {
      type: "boolean",
      description: "Report whether an update exists without installing it",
      default: false,
    },
    force: {
      type: "boolean",
      description: "Download and install even when already up to date",
      default: false,
    },
    "match-engine": {
      type: "boolean",
      description: "Install the version the engine of the active profile runs",
      default: false,
    },
    rollback: {
      type: "boolean",
      description: "Restore the most recently retained subkit binary",
      default: false,
    },
    to: {
      type: "string",
      description: "With --rollback, the retained version to restore (default: the most recent)",
    },
  },
  async run({ args }) {
    const config = defaultUpdaterConfig(CLI_BINARY, VERSION);

    if (args.rollback) {
      let target: string | "previous" = "previous";
      if (typeof args.to === "string" && args.to.length > 0) {
        const parsed = RollbackTargetSchema.safeParse(args.to);
        if (!parsed.success) {
          fail(
            `invalid --to= value '${args.to}': ${parsed.error.issues.map((i) => i.message).join("; ")}`,
            2,
          );
        }
        target = parsed.data;
      }
      runRollback(config, target);
      return;
    }

    const matchEngine = Boolean(args["match-engine"]);
    try {
      const info = matchEngine
        ? await engineRelease(config, activeEngine())
        : await latestRelease(config);
      const action = updateAction(VERSION, info.version, {
        check: Boolean(args.check),
        force: Boolean(args.force),
        exact: matchEngine,
      });
      if (action === "up_to_date") {
        say(
          matchEngine
            ? `already at ${VERSION}, the version of your engine`
            : `already at the latest version ${VERSION}`,
        );
        return;
      }
      if (action === "report") {
        say(`update available ${VERSION} → ${info.version}`);
        return;
      }
      await install(config, info);
    } catch (err) {
      if (isPermissionError(err)) {
        fail(
          `permission denied — ${process.platform === "win32" ? "run as Administrator" : "sudo subkit update"}`,
          2,
        );
      }
      fail(`update failed: ${err instanceof Error ? err.message : String(err)}`, 1);
    }
  },
});

async function install(config: UpdaterConfig, info: UpdateInfo): Promise<void> {
  if (!runsAsCompiledBinary(process.execPath)) {
    fail(
      `this subkit runs from source under ${process.execPath}; only an installed binary updates itself`,
      2,
    );
  }
  say(`updating ${VERSION} → ${info.version}...`);
  await performUpdate(config, info);
  say(`updated to ${info.version}.`);
  for (const path of migrateAgentHooks()) say(`migrated \`sk agent\` hooks in ${path}`);
}

export function migrateAgentHooks(home: string = process.env.HOME || homedir()): string[] {
  try {
    return migrateLegacyAgentHookFiles(home);
  } catch {
    return [];
  }
}

function runRollback(config: UpdaterConfig, target: string | "previous"): void {
  if (listRetainedVersions(config).length === 0) {
    fail("no retained binaries — run `subkit update` at least once before rolling back", 1);
  }
  try {
    say(`rolling back ${VERSION} → ${target}...`);
    const result = rollbackTo(config, target);
    say(`rolled back to ${result.to_version}.`);
  } catch (err) {
    if (isPermissionError(err)) {
      fail(
        `permission denied — ${process.platform === "win32" ? "run as Administrator" : "sudo subkit update --rollback"}`,
        2,
      );
    }
    fail(`rollback failed: ${err instanceof Error ? err.message : String(err)}`, 1);
  }
}

function isPermissionError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM";
  }
  return false;
}
