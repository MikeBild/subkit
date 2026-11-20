import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import {
  autostartDirectory,
  autostartEntry,
  autostartExecutable,
  HIDDEN_FLAG,
  startsHidden,
} from "../shared/autostart.ts";
import { CHANNEL } from "./channel.ts";

function autostartPath(): string {
  return join(autostartDirectory(process.env, homedir()), CHANNEL.autostartFile);
}

function entry(): string {
  return autostartEntry({
    name: CHANNEL.name,
    executable: autostartExecutable(process.env, process.execPath),
  });
}

export function launchesAtLogin(): boolean {
  if (process.platform !== "linux") {
    const settings = app.getLoginItemSettings({ args: [HIDDEN_FLAG] });
    return process.platform === "win32"
      ? settings.executableWillLaunchAtLogin
      : settings.openAtLogin;
  }
  try {
    return readFileSync(autostartPath(), "utf8") === entry();
  } catch {
    return false;
  }
}

export function setLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return;
  if (process.platform !== "linux") {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_FLAG] });
    return;
  }
  if (!enabled) {
    rmSync(autostartPath(), { force: true });
    return;
  }
  mkdirSync(autostartDirectory(process.env, homedir()), { recursive: true });
  writeFileSync(autostartPath(), entry());
}

export function launchedHidden(): boolean {
  return startsHidden({
    argv: process.argv,
    platform: process.platform,
    openedAtLogin:
      process.platform === "darwin" &&
      app.isPackaged &&
      app.getLoginItemSettings().wasOpenedAtLogin,
  });
}
