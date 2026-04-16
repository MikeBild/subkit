// `subkit update` — self-update the subkit CLI binary from GitHub Releases.

import { defineCommand } from "citty";
import {
  VERSION,
  checkForUpdate,
  defaultUpdaterConfig,
  performUpdate,
} from "@cli-core/index.ts";

export const updateCommand = defineCommand({
  meta: { name: "update", description: "Update subkit CLI to the latest version" },
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
  },
  async run({ args }) {
    const channel = args.channel === "beta" ? "beta" : "stable" as const;
    const config = defaultUpdaterConfig("subkit", VERSION, channel);

    process.stdout.write(`subkit: checking for updates (channel: ${channel})...\n`);

    try {
      const info = await checkForUpdate(config, Boolean(args.force) || Boolean(args.check));

      if (!info || info.assets.length === 0) {
        if (args.force && !args.check) {
          const fullInfo = await checkForUpdate({ ...config, checkIntervalMs: 0 }, true);
          if (!fullInfo || fullInfo.assets.length === 0) {
            process.stdout.write(`subkit: already at latest version ${VERSION}\n`);
            return;
          }
          await doUpdate(config, fullInfo);
          return;
        }
        process.stdout.write(`subkit: already at latest version ${VERSION}\n`);
        return;
      }

      if (args.check) {
        process.stdout.write(`subkit: update available ${VERSION} → ${info.version}\n`);
        return;
      }

      await doUpdate(config, info);
    } catch (err) {
      if (isPermissionError(err)) {
        const hint = process.platform === "win32"
          ? "run as Administrator"
          : "sudo subkit update";
        process.stderr.write(`subkit: permission denied — ${hint}\n`);
        process.exit(2);
      }
      process.stderr.write(
        `subkit: update failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  },
});

async function doUpdate(
  config: import("@cli-core/index.ts").UpdaterConfig,
  info: import("@cli-core/index.ts").UpdateInfo,
): Promise<void> {
  process.stdout.write(`subkit: updating ${VERSION} → ${info.version}...\n`);
  await performUpdate(config, info);
  process.stdout.write(
    `subkit: updated to ${info.version}. Restart your terminal to use the new version.\n`,
  );
}

function isPermissionError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM";
  }
  return false;
}
