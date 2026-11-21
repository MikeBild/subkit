import type { Locale } from "./i18n.ts";

const SHELL_MESSAGES = {
  "tray.pausedUntil": { de: "Pausiert bis {time} Uhr", en: "Paused until {time}" },
  "tray.quietUntil": { de: "Ruhezeit bis {time} Uhr", en: "Quiet hours until {time}" },
  "tray.paused": { de: "Pausiert bis zum Fortsetzen", en: "Paused until resumed" },
  "tray.quiet": { de: "Ruhezeit", en: "Quiet hours" },
  "tray.quickCapture": { de: "Schnellnotiz …", en: "Quick note …" },

  "status.offline.title": { de: "Server offline", en: "Server offline" },
  "status.offline.body": {
    de: "SubKit versucht automatisch, die Verbindung wiederherzustellen.",
    en: "SubKit tries to restore the connection automatically.",
  },
  "status.online.title": { de: "Wieder verbunden", en: "Connected again" },
  "status.online.body": {
    de: "Die Verbindung zum Server steht wieder.",
    en: "The connection to the server is back.",
  },
  "status.expired.title": { de: "Sitzung abgelaufen", en: "Session expired" },
  "status.expired.body": {
    de: "Melde dich erneut an, um weiterzuarbeiten.",
    en: "Sign in again to keep working.",
  },
  "status.revoked.title": { de: "Gerät abgemeldet", en: "Device signed out" },
  "status.revoked.body": {
    de: "Dieses Gerät wurde vom Server abgemeldet. Verbinde dich erneut.",
    en: "This device was signed out by the server. Connect again.",
  },
  "status.update.title": { de: "Update verfügbar", en: "Update available" },
  "status.update.body": {
    de: "SubKit Desktop {version} wird geladen.",
    en: "SubKit Desktop {version} is downloading.",
  },

  "common.close": { de: "Schließen", en: "Close" },
  "common.cancel": { de: "Abbrechen", en: "Cancel" },
  "common.offline": { de: "Offline", en: "Offline" },
  "key.ctrl": { de: "Strg", en: "Ctrl" },
  "key.space": { de: "Leertaste", en: "Space" },

  "quick.title": { de: "Schnellnotiz", en: "Quick note" },
  "quick.hint": { de: "{key} – SubKit schnell öffnen", en: "{key} – open SubKit quickly" },
  "quick.ph": { de: "Was willst du festhalten?", en: "What do you want to capture?" },
  "quick.send": { de: "In den Eingang", en: "Into the inbox" },
  "quick.label": { de: "Notiz", en: "Note" },
  "quick.keys": { de: "{mod} ↩ sendet · Esc schließt", en: "{mod} ↩ sends · Esc closes" },
  "quick.sent": { de: "Notiz im Eingang", en: "Note in the inbox" },
  "quick.failed": { de: "Nicht gesendet. Versuch es noch einmal.", en: "Not sent. Try again." },

  "drop.title": { de: "Wohin damit?", en: "Where should this go?" },
  "drop.lead.one": { de: "Eine Datei ist angekommen.", en: "One file has arrived." },
  "drop.lead.many": { de: "{count} Dateien sind angekommen.", en: "{count} files have arrived." },
  "drop.via.window": { de: "In das Fenster gezogen", en: "Dragged into the window" },
  "drop.via.dock": { de: "Auf das Dock-Symbol gezogen", en: "Dragged onto the dock icon" },
  "drop.via.tray": { de: "Auf das Tray-Symbol gezogen", en: "Dragged onto the tray icon" },
  "drop.choice.file": { de: "Als Datei ablegen", en: "Store as file" },
  "drop.choice.file.hint": {
    de: "Unter Dateien, mit @attachment:-Verweis",
    en: "Under Files, with an @attachment: reference",
  },
  "drop.choice.source": { de: "Als Quelle einlesen", en: "Ingest as source" },
  "drop.choice.source.hint": {
    de: "SubKit teilt sie in Abschnitte",
    en: "SubKit splits it into sections",
  },
  "drop.choice.chat": { de: "Im Chat anhängen", en: "Attach in chat" },
  "drop.choice.chat.hint": { de: "An deine nächste Nachricht", en: "To your next message" },
  "drop.choice.inbox": { de: "In den Eingang", en: "Into the inbox" },
  "drop.choice.inbox.hint": {
    de: "SubKit prüft sie und schlägt vor, was daraus wird",
    en: "SubKit reviews it and suggests what it becomes",
  },
  "drop.reason.tooLarge": { de: "Größer als {max}", en: "Larger than {max}" },
  "drop.reason.unsupported": { de: "Dateityp nicht unterstützt", en: "File type not supported" },
  "drop.reason.tooMany": { de: "Höchstens {max} Dateien", en: "At most {max} files" },
  "drop.reason.offline": { de: "Offline", en: "Offline" },
  "drop.failed": { de: "Nicht abgelegt. Versuch es noch einmal.", en: "Not placed. Try again." },
  "drop.placed.file": { de: "„{name}“ als Datei abgelegt", en: "“{name}” stored as file" },
  "drop.placed.source": { de: "„{name}“ als Quelle eingelesen", en: "“{name}” ingested as source" },
  "drop.placed.inbox": { de: "„{name}“ in den Eingang gelegt", en: "“{name}” put into the inbox" },

  "browser.label": { de: "Systembrowser", en: "System browser" },
  "browser.reauthTitle": {
    de: "SubKit den Zugriff auf {name} erlauben",
    en: "Allow SubKit to access {name}",
  },
  "browser.reauthBody": {
    de: "SubKit erhält dieselben Rechte wie zuvor. Du kannst sie jederzeit widerrufen.",
    en: "SubKit gets the same permissions as before. You can revoke them at any time.",
  },
  "browser.reauthConfirm": {
    de: "Zugriff im Browser erlauben",
    en: "Allow access in browser",
  },
  "browser.cancel": { de: "Abbrechen", en: "Cancel" },
  "browser.succeeded": { de: "Verbunden. SubKit lädt neu …", en: "Connected. SubKit reloads …" },
  "browser.failed": {
    de: "Anmeldung fehlgeschlagen. Versuch es noch einmal.",
    en: "Sign-in failed. Try again.",
  },
} as const;

export type ShellMessageKey = keyof typeof SHELL_MESSAGES;
export type ShellMessages = Record<ShellMessageKey, string>;

export function st(
  locale: Locale,
  key: ShellMessageKey,
  vars: Record<string, string | number> = {},
): string {
  return fill(SHELL_MESSAGES[key][locale], vars);
}

export function fill(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function shellMessageKeys(): ShellMessageKey[] {
  return Object.keys(SHELL_MESSAGES) as ShellMessageKey[];
}

export function shellDictionary(locale: Locale): ShellMessages {
  const out = {} as ShellMessages;
  for (const key of shellMessageKeys()) out[key] = SHELL_MESSAGES[key][locale];
  return out;
}

export function clockLabel(locale: Locale, at: Date): string {
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: locale !== "de",
  }).format(at);
}
