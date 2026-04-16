// Engine self-update logic, extracted for testability.
// Invoked via `engine --self-update` — does not require DATABASE_URL
// or any other server infrastructure.

import { checkForUpdate, defaultUpdaterConfig, performUpdate } from "@cli-core/updater.ts";
import { VERSION } from "@cli-core/version.ts";

export async function runSelfUpdate(fetchImpl?: typeof fetch): Promise<void> {
  const config = defaultUpdaterConfig("engine", VERSION);
  process.stdout.write("engine: checking for updates...\n");

  const info = await checkForUpdate(config, true, fetchImpl);
  if (!info || info.assets.length === 0) {
    process.stdout.write(`engine: already at latest version ${VERSION}\n`);
    return;
  }

  process.stdout.write(`engine: updating ${VERSION} → ${info.version}...\n`);
  await performUpdate(config, info, fetchImpl);
  process.stdout.write(
    `engine: updated to ${info.version}. Restart the engine to use the new version.\n`,
  );
}
