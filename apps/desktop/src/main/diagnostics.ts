import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { dirname } from "node:path";
import { app, type BrowserWindow, dialog } from "electron";
import {
  BUNDLE_LOG_LINES,
  buildDiagnostics,
  type DesktopDiagnostics,
  type ErrorEntry,
  type LocalStatus,
  parseCodesign,
  type SigningInfo,
} from "../shared/diagnostics.ts";
import type { Locale } from "../shared/i18n.ts";
import { appLog } from "./app-log.ts";
import { crashCapture } from "./crash-capture.ts";

export interface DiagnosticsContext {
  locale: Locale;
  serverOrigin: string | null;
  serverVersion: string | null;
  connection: string;
  profileCount: number;
  errors: readonly ErrorEntry[];
  local?: LocalStatus | undefined;
  runner?: string | null | undefined;
  permissions?: Readonly<Record<string, string>> | undefined;
}

let signing: SigningInfo | null | undefined;

function signingInfo(): SigningInfo | null {
  if (signing !== undefined) return signing;
  signing = null;
  if (process.platform !== "darwin" || !app.isPackaged) return signing;
  try {
    const bundle = dirname(dirname(dirname(process.execPath)));
    const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=2", bundle], {
      encoding: "utf8",
      timeout: 3000,
    });
    signing = parseCodesign(`${result.stdout ?? ""}${result.stderr ?? ""}`, result.status);
  } catch {
    signing = null;
  }
  return signing;
}

export function diagnosticsBundle(context: DiagnosticsContext): DesktopDiagnostics {
  return buildDiagnostics(
    {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? "",
      chromeVersion: process.versions.chrome ?? "",
      platform: process.platform,
      osRelease: release(),
      arch: process.arch,
      locale: app.getLocale(),
      packaged: app.isPackaged,
      serverOrigin: context.serverOrigin,
      serverVersion: context.serverVersion,
      connection: context.connection,
      profileCount: context.profileCount,
      errors: context.errors,
      generatedAt: new Date().toISOString(),
      signing: signingInfo() ?? undefined,
      logTail: appLog.tail(BUNDLE_LOG_LINES),
      crashes: crashCapture.recent(),
      minidumps: crashCapture.minidumps(),
      local: context.local,
      runner: context.runner,
      permissions: context.permissions,
      secrets: appLog.knownSecrets(),
    },
    homedir(),
  );
}

export function diagnosticsText(context: DiagnosticsContext): string {
  return `${JSON.stringify(diagnosticsBundle(context), null, 2)}\n`;
}

export async function saveDiagnostics(parent: BrowserWindow | null, text: string): Promise<void> {
  const options = {
    defaultPath: `subkit-desktop-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  };
  const target = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options);
  if (!target.canceled && target.filePath) await writeFile(target.filePath, text, { mode: 0o600 });
}
