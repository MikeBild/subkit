import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { app, dialog } from "electron";
import { earlyLogFile, earlyLogFolder, installEarlyGuard } from "../shared/early-guard.ts";
import { resolveLocale, t } from "../shared/i18n.ts";

const folder = earlyLogFolder(process.platform, process.env, homedir());

export const releaseEarlyGuard = installEarlyGuard({
  on: (event, listener) => process.on(event, listener),
  off: (event, listener) => process.off(event, listener),
  write: (line) => {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    appendFileSync(earlyLogFile(folder, process.platform), line, { mode: 0o600 });
  },
  fatal: (error) => {
    void app.whenReady().then(() => {
      const locale = resolveLocale("system", app.getLocale());
      const reason = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox(
        t(locale, "startup.title"),
        [t(locale, "startup.app.next"), reason, t(locale, "startup.logs", { folder })].join("\n\n"),
      );
      app.exit(1);
    });
  },
  now: () => new Date(),
  home: homedir(),
});
