import { CLI_BINARY } from "./release/assets.ts";
import {
  backgroundCheckAllowed,
  managingPackageManager,
  refreshDue,
  updateHint,
} from "./release/update-policy.ts";
import {
  checkForUpdate,
  cleanupOldBinary,
  defaultUpdaterConfig,
  readCache,
  type UpdaterConfig,
} from "./updater.ts";
import { VERSION } from "./version.ts";

interface HintSink {
  isTTY?: boolean;
  write(text: string): unknown;
}

export interface UpdateNotifierOptions {
  command: string | undefined;
  machineReadable: boolean;
  enabledInSettings: boolean;
  config?: UpdaterConfig;
  fetchImpl?: typeof fetch;
  sink?: HintSink;
  onExit?: (listener: () => void) => void;
  now?: number;
}

export function startUpdateNotifier(options: UpdateNotifierOptions): Promise<void> | null {
  const config = options.config ?? defaultUpdaterConfig(CLI_BINARY, VERSION);
  const sink = options.sink ?? process.stderr;
  const allowed = backgroundCheckAllowed({
    enabledInSettings: options.enabledInSettings,
    disabledByEnv: process.env.NO_UPDATE_CHECK === "1",
    stderrIsTTY: Boolean(sink.isTTY),
    command: options.command,
    machineReadable: options.machineReadable,
    currentVersion: config.currentVersion,
  });
  if (!allowed) return null;

  cleanupOldBinary();
  const cache = readCache(config.cacheDir);
  let latest = cache?.latest_version ?? null;
  const onExit = options.onExit ?? ((listener) => process.once("exit", listener));
  onExit(() => {
    const hint = updateHint(
      config.currentVersion,
      latest,
      managingPackageManager(process.execPath),
    );
    if (hint) sink.write(`${hint}\n`);
  });

  if (!refreshDue(cache?.last_check ?? null, options.now ?? Date.now(), config.checkIntervalMs)) {
    return Promise.resolve();
  }
  return checkForUpdate(config, true, options.fetchImpl)
    .then(() => {
      latest = readCache(config.cacheDir)?.latest_version ?? latest;
    })
    .catch(() => {});
}
