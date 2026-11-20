export const HIDDEN_FLAG = "--hidden";

const DESKTOP_ENTRY_RESERVED = /["`$\\]/g;

export function quoteDesktopExec(executable: string): string {
  return `"${executable.replace(DESKTOP_ENTRY_RESERVED, (char) => `\\${char}`).replaceAll("%", "%%")}"`;
}

export function autostartEntry(input: { name: string; executable: string }): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${input.name.replace(/[\r\n]/g, " ")}`,
    `Exec=${quoteDesktopExec(input.executable.replace(/[\r\n]/g, ""))} ${HIDDEN_FLAG}`,
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

export function autostartExecutable(
  env: Record<string, string | undefined>,
  execPath: string,
): string {
  const image = env.APPIMAGE;
  return image?.trim() ? image : execPath;
}

export function autostartDirectory(env: Record<string, string | undefined>, home: string): string {
  const configured = env.XDG_CONFIG_HOME;
  const config = configured?.startsWith("/") ? configured : `${home}/.config`;
  return `${config.replace(/\/+$/, "")}/autostart`;
}

export function startsHidden(input: {
  argv: readonly string[];
  platform: string;
  openedAtLogin: boolean;
}): boolean {
  if (input.argv.slice(1).includes(HIDDEN_FLAG)) return true;
  return input.platform === "darwin" && input.openedAtLogin;
}
