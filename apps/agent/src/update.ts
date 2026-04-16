// Tunnel agent update logic, extracted for testability.
// Provides startup check, self-update, and periodic re-check.

import { checkForUpdate, defaultUpdaterConfig, performUpdate } from "@cli-core/updater.ts";
import { VERSION } from "@cli-core/version.ts";
import { log } from "./logger.ts";

export async function checkAndLogUpdate(fetchImpl?: typeof fetch): Promise<void> {
  const config = defaultUpdaterConfig("tunnel-agent", VERSION);
  const info = await checkForUpdate(config, false, fetchImpl);
  if (info) {
    log.warn("update available", {
      current_version: VERSION,
      latest_version: info.version,
      action: "run tunnel-agent --self-update to update",
    });
  }
}

export async function runAgentSelfUpdate(fetchImpl?: typeof fetch): Promise<void> {
  const config = defaultUpdaterConfig("tunnel-agent", VERSION);
  log.info("checking for updates...", {});
  const info = await checkForUpdate(config, true, fetchImpl);
  if (!info || info.assets.length === 0) {
    log.info("already at latest version", { version: VERSION });
    return;
  }
  log.info("updating", { from: VERSION, to: info.version });
  await performUpdate(config, info, fetchImpl);
  log.info("updated successfully", { version: info.version });
}

export function startPeriodicUpdateCheck(
  intervalMs = 86_400_000,
  fetchImpl?: typeof fetch,
): ReturnType<typeof setInterval> {
  const timer = setInterval(async () => {
    try {
      await checkAndLogUpdate(fetchImpl);
    } catch {
      /* silent */
    }
  }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}
