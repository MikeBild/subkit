import { errorFields, formatLogLine, LOG_FILE } from "./app-log.ts";

export const EARLY_APP_NAME = "SubKit";

export function earlyLogFolder(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const separator = platform === "win32" ? "\\" : "/";
  const join = (...parts: string[]) => parts.join(separator);
  if (platform === "darwin") return join(home, "Library", "Logs", EARLY_APP_NAME);
  if (platform === "win32")
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), EARLY_APP_NAME, "logs");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), EARLY_APP_NAME, "logs");
}

export function earlyLogFile(folder: string, platform: string): string {
  return `${folder}${platform === "win32" ? "\\" : "/"}${LOG_FILE}`;
}

export function earlyLogLine(event: string, error: unknown, at: Date, home: string): string {
  return formatLogLine(
    { at: at.toISOString(), level: "error", event, fields: errorFields(error) },
    { secrets: [], homeDir: home },
  );
}

export interface EarlyGuardPorts {
  on(event: "uncaughtException", listener: (error: unknown) => void): void;
  off(event: "uncaughtException", listener: (error: unknown) => void): void;
  write(line: string): void;
  fatal(error: unknown): void;
  now(): Date;
  home: string;
}

export function installEarlyGuard(ports: EarlyGuardPorts): () => void {
  let fatalShown = false;
  const listener = (error: unknown) => {
    try {
      ports.write(`${earlyLogLine("main.early_uncaught", error, ports.now(), ports.home)}\n`);
    } catch {}
    if (fatalShown) return;
    fatalShown = true;
    ports.fatal(error);
  };
  ports.on("uncaughtException", listener);
  return () => ports.off("uncaughtException", listener);
}
