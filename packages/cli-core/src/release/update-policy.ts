import { CLI_BINARY } from "./assets.ts";
import { isDevBuild, isNewer } from "./version.ts";

export const UPDATE_CHECK_INTERVAL_MS = 86_400_000;

const COMMANDS_WITHOUT_HINT = new Set(["update", "mcp"]);

export interface BackgroundCheckInput {
  enabledInSettings: boolean;
  disabledByEnv: boolean;
  stderrIsTTY: boolean;
  command: string | undefined;
  machineReadable: boolean;
  currentVersion: string;
}

export function backgroundCheckAllowed(input: BackgroundCheckInput): boolean {
  if (!input.enabledInSettings || input.disabledByEnv) return false;
  if (!input.stderrIsTTY || input.machineReadable) return false;
  if (input.command && COMMANDS_WITHOUT_HINT.has(input.command)) return false;
  return !isDevBuild(input.currentVersion);
}

export function refreshDue(
  lastCheck: number | null,
  now: number,
  intervalMs: number = UPDATE_CHECK_INTERVAL_MS,
): boolean {
  if (lastCheck === null || !Number.isFinite(lastCheck)) return true;
  return now - lastCheck >= intervalMs || now < lastCheck;
}

export const WINGET_PACKAGE_ID = "MikeBild.SubKitCLI";

export type PackageManager = "winget";

export function managingPackageManager(execPath: string): PackageManager | null {
  return /[\\/]Microsoft[\\/]WinGet[\\/](Packages|Links)[\\/]/i.test(execPath) ? "winget" : null;
}

export const packageManagerUpdateCommand = (manager: PackageManager): string =>
  manager === "winget" ? `winget upgrade ${WINGET_PACKAGE_ID}` : "";

export function updateHint(
  current: string,
  latest: string | null,
  manager: PackageManager | null = null,
): string | null {
  if (!latest || !isNewer(latest, current)) return null;
  const command = manager ? packageManagerUpdateCommand(manager) : `${CLI_BINARY} update`;
  return `${CLI_BINARY} ${latest} is available (you have ${current}). Run \`${command}\` to install it.`;
}

export function runsAsCompiledBinary(execPath: string): boolean {
  const name = execPath.split(/[\\/]/).pop() ?? "";
  return !/^(bun|node)(\.exe)?$/i.test(name);
}

export type UpdateAction = "up_to_date" | "report" | "install";

export function updateAction(
  current: string,
  target: string,
  options: { check: boolean; force: boolean; exact: boolean },
): UpdateAction {
  const differs = options.exact ? current.trim() !== target.trim() : isNewer(target, current);
  if (!differs && !options.force) return "up_to_date";
  return options.check ? "report" : "install";
}
