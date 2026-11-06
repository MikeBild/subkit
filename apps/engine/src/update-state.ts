import { checkForUpdate, defaultUpdaterConfig } from "@cli-core/updater.ts";
import { logger } from "./logging/logger.ts";

interface EngineUpdateState {
  update_available: boolean;
  latest_version: string;
}

let state: EngineUpdateState | null = null;

export function setUpdateState(s: EngineUpdateState): void {
  state = s;
}

export function getUpdateState(): EngineUpdateState | null {
  return state;
}

export function resetUpdateState(): void {
  state = null;
}

export function startEngineUpdateCheck(currentVersion: string): Promise<void> {
  return checkForUpdate(defaultUpdaterConfig("engine", currentVersion))
    .then((info) => {
      if (info) {
        setUpdateState({ update_available: true, latest_version: info.version });
        logger.warn({
          module: "engine",
          action: "update.available",
          msg: `update available: ${info.version}`,
          current_version: currentVersion,
          latest_version: info.version,
        });
        return;
      }
      setUpdateState({ update_available: false, latest_version: currentVersion });
    })
    .catch(() => {});
}
