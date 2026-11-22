import { writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { app, type BrowserWindow, clipboard, dialog } from "electron";
import type { AnonymousReportOutcome } from "../shared/anonymous-report.ts";
import {
  buildDiagnostics,
  type DesktopDiagnostics,
  type ErrorEntry,
} from "../shared/diagnostics.ts";
import { type Locale, t } from "../shared/i18n.ts";

export interface DiagnosticsContext {
  locale: Locale;
  serverOrigin: string | null;
  serverVersion: string | null;
  connection: string;
  profileCount: number;
  errors: readonly ErrorEntry[];
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
    },
    homedir(),
  );
}

export type SendDiagnostics = (bundle: DesktopDiagnostics) => Promise<AnonymousReportOutcome>;

async function showBox(
  parent: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

async function saveDiagnostics(text: string): Promise<void> {
  const target = await dialog.showSaveDialog({
    defaultPath: `subkit-desktop-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!target.canceled && target.filePath) await writeFile(target.filePath, text, { mode: 0o600 });
}

export async function offerDiagnostics(
  parent: BrowserWindow | null,
  context: DiagnosticsContext,
  send: SendDiagnostics | null = null,
): Promise<void> {
  const { locale } = context;
  const actions = send
    ? (["send", "copy", "save", "cancel"] as const)
    : (["copy", "save", "cancel"] as const);
  const choice = await showBox(parent, {
    type: "info",
    title: t(locale, "report.title"),
    message: t(locale, "report.title"),
    detail: t(locale, send ? "report.sendDetail" : "report.detail"),
    buttons: actions.map((action) => t(locale, `report.${action}`)),
    defaultId: 0,
    cancelId: actions.length - 1,
  });
  const action = actions[choice.response] ?? "cancel";
  if (action === "cancel") return;
  const bundle = diagnosticsBundle(context);
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  if (action === "copy") return clipboard.writeText(text);
  if (action === "save") return saveDiagnostics(text);
  if (!send) return;
  const outcome = await send(bundle);
  await showBox(parent, {
    type: outcome === "sent" ? "info" : "warning",
    title: t(locale, "report.title"),
    message: t(locale, `report.${outcome}`),
    detail: t(locale, `report.${outcome}.detail`),
    buttons: [t(locale, "report.close")],
  });
}
