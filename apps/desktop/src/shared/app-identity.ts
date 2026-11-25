import { type Locale, t } from "./i18n.ts";

export const COPYRIGHT = "© 2026 Mike Bild";
export const WEBSITE = "https://subkit.mikebild.dev";
export const DEFAULT_SERVER = "https://subkit-cloud.mikebild.dev";
export const NOTICES_FILE = "THIRD_PARTY_NOTICES.txt";
export const MIN_MACOS = "13.0";

type Text = Record<Locale, string>;

export const USAGE_DESCRIPTIONS = {
  NSDesktopFolderUsageDescription: {
    de: "SubKit liest und ändert Dateien auf deinem Schreibtisch nur in Ordnern, die du erlaubt hast.",
    en: "SubKit reads and changes files on your desktop only in folders you have allowed.",
  },
  NSDocumentsFolderUsageDescription: {
    de: "SubKit liest und ändert deine Dokumente nur in Ordnern, die du erlaubt hast.",
    en: "SubKit reads and changes your documents only in folders you have allowed.",
  },
  NSDownloadsFolderUsageDescription: {
    de: "SubKit liest und speichert Downloads nur in Ordnern, die du erlaubt hast.",
    en: "SubKit reads and saves downloads only in folders you have allowed.",
  },
  NSRemovableVolumesUsageDescription: {
    de: "SubKit liest und ändert Dateien auf externen Laufwerken nur in Ordnern, die du erlaubt hast.",
    en: "SubKit reads and changes files on external drives only in folders you have allowed.",
  },
  NSNetworkVolumesUsageDescription: {
    de: "SubKit liest und ändert Dateien auf Netzlaufwerken nur in Ordnern, die du erlaubt hast.",
    en: "SubKit reads and changes files on network drives only in folders you have allowed.",
  },
  NSMicrophoneUsageDescription: {
    de: t("de", "usage.microphone"),
    en: t("en", "usage.microphone"),
  },
  NSLocalNetworkUsageDescription: {
    de: "SubKit verbindet sich mit einem SubKit-Server in deinem lokalen Netzwerk, wenn du seine Adresse eingibst.",
    en: "SubKit connects to a SubKit server in your local network when you enter its address.",
  },
} as const satisfies Record<string, Text>;

export type UsageKey = keyof typeof USAGE_DESCRIPTIONS;

export const ELECTRON_USAGE_KEYS_REMOVED = [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
] as const;

export const INFO_PLIST_LOCALES: readonly Locale[] = ["de", "en"];

function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function infoPlistStrings(locale: Locale, displayName: string): string {
  const entries: [string, string][] = [
    ["CFBundleDisplayName", displayName],
    ["CFBundleName", displayName],
    ...Object.entries(USAGE_DESCRIPTIONS).map(([key, text]): [string, string] => [
      key,
      text[locale],
    ]),
  ];
  return `${entries.map(([key, value]) => `${key} = ${quoted(value)};`).join("\n")}\n`;
}

const CREDITS: Record<Locale, (site: string) => string> = {
  de: (site) =>
    `${site}\nHinweise zu Software von Drittanbietern: ${NOTICES_FILE} im Ordner „Resources“ der App`,
  en: (site) => `${site}\nThird-party notices: ${NOTICES_FILE} in the app’s Resources folder`,
};

export interface AboutPanel {
  applicationName: string;
  applicationVersion: string;
  copyright: string;
  credits: string;
  website: string;
}

export function aboutPanel(locale: Locale, name: string, version: string): AboutPanel {
  return {
    applicationName: name,
    applicationVersion: version,
    copyright: COPYRIGHT,
    credits: CREDITS[locale](WEBSITE.replace(/^https:\/\//, "")),
    website: WEBSITE,
  };
}
