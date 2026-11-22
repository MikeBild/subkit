import { app, clipboard, dialog, shell } from "electron";
import { type Locale, resolveLocale, t } from "../shared/i18n.ts";
import {
  classifyStartupFailure,
  type StartupFailure,
  type StartupPhase,
  startupActionAt,
} from "../shared/startup-failure.ts";
import { appLog } from "./app-log.ts";

export interface StartupFailureHost {
  locale?: (() => Locale) | undefined;
  diagnostics: () => string;
}

function localeOf(host: StartupFailureHost): Locale {
  try {
    return host.locale?.() ?? resolveLocale("system", app.getLocale());
  } catch {
    return "en";
  }
}

export async function showStartupFailure(
  phase: StartupPhase,
  error: unknown,
  host: StartupFailureHost,
): Promise<StartupFailure> {
  const reason = error instanceof Error ? error.message : String(error);
  const failure = classifyStartupFailure(phase, reason);
  appLog.error("startup.failed", error, { phase, kind: failure.kind });
  const locale = localeOf(host);
  const folder = appLog.directory;
  for (;;) {
    const choice = await dialog.showMessageBox({
      type: "error",
      title: t(locale, "startup.title"),
      message: t(locale, failure.title),
      detail: [t(locale, failure.next), folder ? t(locale, "startup.logs", { folder }) : ""]
        .filter(Boolean)
        .join("\n\n"),
      buttons: [t(locale, "report.copy"), t(locale, "startup.openLogs"), t(locale, "tray.quit")],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    const action = startupActionAt(choice.response);
    if (action === "quit") return failure;
    if (action === "copy") {
      try {
        clipboard.writeText(host.diagnostics());
      } catch (copyError) {
        appLog.error("startup.copy_failed", copyError);
      }
    }
    if (action === "logs" && folder) await shell.openPath(folder);
  }
}
