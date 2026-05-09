// `sk update` — self-update the sk CLI binary from GitHub Releases.
//
// `--rollback [--to=<version>]` swaps the running `sk` binary with a
// previously retained signed binary under `~/.sk/versions/<version>/`.
// The retention store is populated by every successful `performUpdate`
// (see `@cli-core/updater::performUpdate`), so rollback only works
// after at least one self-update has run. The cli-side rollback writes
// no audit row — `sk` is the operator's CLI, not a server, and has no
// database. The engine-side `engine --rollback` is the audited path
// (issue #151 P0-4).

import {
  checkForUpdate,
  defaultUpdaterConfig,
  listRetainedVersions,
  performUpdate,
  rollbackTo,
  VERSION,
} from "@cli-core/index.ts";
import { defineCommand } from "citty";
import { z } from "zod";

// AGENTS.md "Every CLI input — schema first": symmetric with the engine
// rollback validator at apps/engine/src/index.ts. Reject empty / shell-
// suspicious values up front instead of letting them surface later as
// "no retained binaries for '../../etc/passwd'".
const RollbackTargetSchema = z
  .string()
  .min(1, "--to= must not be empty")
  .regex(/^[A-Za-z0-9._+-]+$/, "--to= must look like a version (e.g. 4.2.0)");

export const updateCommand = defineCommand({
  meta: { name: "update", description: "Update sk CLI to the latest version" },
  args: {
    force: {
      type: "boolean",
      description: "Force re-download even if already up to date",
      default: false,
    },
    check: {
      type: "boolean",
      description: "Check for updates without installing",
      default: false,
    },
    channel: {
      type: "string",
      description: "Release channel: stable | beta",
      default: "stable",
    },
    rollback: {
      type: "boolean",
      description: "Restore the most recent retained sk binary",
      default: false,
    },
    to: {
      type: "string",
      description:
        "With --rollback, the explicit version to restore (default: most recent retained)",
    },
  },
  async run({ args }) {
    const channel = args.channel === "beta" ? "beta" : ("stable" as const);
    const config = defaultUpdaterConfig("sk", VERSION, channel);

    if (args.rollback) {
      let target: string | "previous" = "previous";
      if (typeof args.to === "string" && args.to.length > 0) {
        const parsed = RollbackTargetSchema.safeParse(args.to);
        if (!parsed.success) {
          process.stderr.write(
            `sk: invalid --to= value '${args.to}': ${parsed.error.issues.map((i) => i.message).join("; ")}\n`,
          );
          process.exit(2);
        }
        target = parsed.data;
      }
      await runRollback(config, target);
      return;
    }

    process.stdout.write(`sk: checking for updates (channel: ${channel})...\n`);

    try {
      const info = await checkForUpdate(config, Boolean(args.force) || Boolean(args.check));

      if (!info || info.assets.length === 0) {
        if (args.force && !args.check) {
          const fullInfo = await checkForUpdate({ ...config, checkIntervalMs: 0 }, true);
          if (!fullInfo || fullInfo.assets.length === 0) {
            process.stdout.write(`sk: already at latest version ${VERSION}\n`);
            return;
          }
          await doUpdate(config, fullInfo);
          return;
        }
        process.stdout.write(`sk: already at latest version ${VERSION}\n`);
        return;
      }

      if (args.check) {
        process.stdout.write(`sk: update available ${VERSION} → ${info.version}\n`);
        return;
      }

      await doUpdate(config, info);
    } catch (err) {
      if (isPermissionError(err)) {
        const hint = process.platform === "win32" ? "run as Administrator" : "sudo sk update";
        process.stderr.write(`sk: permission denied — ${hint}\n`);
        process.exit(2);
      }
      process.stderr.write(
        `sk: update failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  },
});

async function doUpdate(
  config: import("@cli-core/index.ts").UpdaterConfig,
  info: import("@cli-core/index.ts").UpdateInfo,
): Promise<void> {
  process.stdout.write(`sk: updating ${VERSION} → ${info.version}...\n`);
  await performUpdate(config, info);
  process.stdout.write(
    `sk: updated to ${info.version}. Restart your terminal to use the new version.\n`,
  );
}

async function runRollback(
  config: import("@cli-core/index.ts").UpdaterConfig,
  target: string | "previous",
): Promise<void> {
  const retained = listRetainedVersions(config);
  if (retained.length === 0) {
    process.stdout.write(
      "sk: no retained binaries — there is nothing to roll back to. " +
        "Run `sk update` at least once first.\n",
    );
    process.exit(1);
  }
  try {
    process.stdout.write(`sk: rolling back ${VERSION} → ${target}...\n`);
    const result = rollbackTo(config, target);
    process.stdout.write(
      `sk: rolled back to ${result.to_version}. Restart your terminal to use it.\n`,
    );
  } catch (err) {
    if (isPermissionError(err)) {
      const hint =
        process.platform === "win32" ? "run as Administrator" : "sudo sk update --rollback";
      process.stderr.write(`sk: permission denied — ${hint}\n`);
      process.exit(2);
    }
    process.stderr.write(
      `sk: rollback failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

function isPermissionError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM";
  }
  return false;
}
