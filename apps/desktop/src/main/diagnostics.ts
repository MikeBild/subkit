import { writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { app, type BrowserWindow, clipboard, dialog } from "electron";
import { type Locale, t } from "../shared/i18n.ts";
import { buildDiagnostics, type DesktopDiagnostics, type ErrorEntry } from "../shared/redaction.ts";

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

export function collectDiagnostics(context: DiagnosticsContext): string {
  return `${JSON.stringify(diagnosticsBundle(context), null, 2)}\n`;
}

export async function offerDiagnostics(
  parent: BrowserWindow | null,
  context: DiagnosticsContext,
): Promise<void> {
  const { locale } = context;
  const options = {
    type: "info" as const,
    title: t(locale, "report.title"),
    message: t(locale, "report.title"),
    detail: t(locale, "report.detail"),
    buttons: [t(locale, "report.copy"), t(locale, "report.save"), t(locale, "report.cancel")],
    defaultId: 0,
    cancelId: 2,
  };
  const choice = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (choice.response === 2) return;
  const text = collectDiagnostics(context);
  if (choice.response === 0) return clipboard.writeText(text);
  const target = await dialog.showSaveDialog({
    defaultPath: `subkit-desktop-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!target.canceled && target.filePath) await writeFile(target.filePath, text, { mode: 0o600 });
}
