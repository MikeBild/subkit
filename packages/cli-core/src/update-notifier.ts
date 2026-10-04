import {
  checkForUpdate,
  cleanupOldBinary,
  defaultUpdaterConfig,
  formatUpdateBanner,
} from "./updater.ts";
import { VERSION } from "./version.ts";

export function notifyIfUpdateAvailable(binaryName: string, fetchImpl?: typeof fetch): void {
  if (process.env.NO_UPDATE_CHECK === "1") return;

  cleanupOldBinary();

  const config = defaultUpdaterConfig(binaryName, VERSION);

  checkForUpdate(config, false, fetchImpl)
    .then((info) => {
      if (info) {
        process.stderr.write(formatUpdateBanner(info, binaryName));
      }
    })
    .catch(() => {});
}
