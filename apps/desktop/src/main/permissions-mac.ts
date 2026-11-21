import { app, shell, systemPreferences } from "electron";
import type { PermissionSystem } from "../shared/local/permission-port.ts";

export function electronPermissionSystem(): PermissionSystem {
  return {
    platform: process.platform,
    isTrustedAccessibilityClient: (prompt) =>
      systemPreferences.isTrustedAccessibilityClient(prompt),
    getMediaAccessStatus: (kind) => systemPreferences.getMediaAccessStatus(kind),
    openExternal: (url) => shell.openExternal(url),
    relaunch: () => app.relaunch(),
  };
}
