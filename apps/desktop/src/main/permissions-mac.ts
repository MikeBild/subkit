import { app, desktopCapturer, shell, systemPreferences } from "electron";
import { createHelperRunner } from "../runner/computer/helper.ts";
import type { ComputerSnapshot } from "../shared/local/computer-allowances.ts";
import { helperProbeFrom } from "../shared/local/permission-model.ts";
import type { PermissionSystem } from "../shared/local/permission-port.ts";
import { appLog } from "./app-log.ts";

const HELPER_PROBE_LIMIT_MS = 5_000;

export function electronPermissionSystem(
  helper: () => ComputerSnapshot["helper"],
): PermissionSystem {
  return {
    platform: process.platform,
    processPath: process.execPath,
    isTrustedAccessibilityClient: (prompt) =>
      systemPreferences.isTrustedAccessibilityClient(prompt),
    getMediaAccessStatus: (kind) => systemPreferences.getMediaAccessStatus(kind),
    requestScreenCapture: async () => {
      await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
      });
    },
    probeHelper: async () => {
      const spec = helper();
      if (spec === null) return null;
      const outcome = await createHelperRunner(spec).run(
        { args: ["permissions"], timeoutMs: HELPER_PROBE_LIMIT_MS },
        AbortSignal.timeout(HELPER_PROBE_LIMIT_MS * 2),
      );
      if (outcome.kind !== "envelope" || !outcome.envelope.ok) {
        appLog.warn("permissions.helper_probe", { helper: spec.path, outcome: outcome.kind });
        return null;
      }
      return helperProbeFrom(outcome.envelope.data);
    },
    openExternal: (url) => shell.openExternal(url),
    relaunch: () => app.relaunch(),
    log: (event, fields) => appLog.info(event, fields),
  };
}
