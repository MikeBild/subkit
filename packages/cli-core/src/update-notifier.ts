// Non-blocking startup update check. Called from dispatch() in both
// `sk` and `subkit` entry points. The check runs in the background
// and writes to stderr so it does not interfere with piped output.

import {
  checkForUpdate,
  cleanupOldBinary,
  defaultUpdaterConfig,
  formatUpdateBanner,
} from "./updater.ts";
import { VERSION } from "./version.ts";

export function notifyIfUpdateAvailable(binaryName: string, fetchImpl?: typeof fetch): void {
  if (process.env.NO_UPDATE_CHECK === "1") return;

  // Clean up stale .old file from previous Windows update
  cleanupOldBinary();

  const config = defaultUpdaterConfig(binaryName, VERSION);

  // Fire and forget — never block CLI startup
  checkForUpdate(config, false, fetchImpl)
    .then((info) => {
      if (info) {
        process.stderr.write(formatUpdateBanner(info, binaryName));
      }
    })
    .catch(() => {
      // Silently swallow — never block the CLI
    });
}
