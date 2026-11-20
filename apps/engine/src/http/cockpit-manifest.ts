export const COCKPIT_LINK_PROTOCOL = "web+subkit";
export const COCKPIT_LINK_PARAM = "link";

type ManifestLocale = "de" | "en";
type IconPurpose = "any" | "maskable" | "monochrome";

interface IconVariant {
  file: string;
  asset: string;
  size: 192 | 512;
  purpose: IconPurpose;
}

const ICON_VARIANTS: readonly IconVariant[] = [
  { file: "192.png", asset: "app-icon-192.png", size: 192, purpose: "any" },
  { file: "512.png", asset: "app-icon-512.png", size: 512, purpose: "any" },
  { file: "maskable-192.png", asset: "app-icon-maskable-192.png", size: 192, purpose: "maskable" },
  { file: "maskable-512.png", asset: "app-icon-maskable-512.png", size: 512, purpose: "maskable" },
  {
    file: "monochrome-512.png",
    asset: "app-icon-monochrome-512.png",
    size: 512,
    purpose: "monochrome",
  },
];

const SHORTCUTS: readonly { path: string; name: Record<ManifestLocale, string> }[] = [
  { path: "chat", name: { de: "Chat", en: "Chat" } },
  { path: "tasks", name: { de: "Aufgaben", en: "Tasks" } },
  { path: "intake", name: { de: "Eingang", en: "Inbox" } },
];

export function cockpitIconVariant(file: string | undefined): IconVariant | null {
  return ICON_VARIANTS.find((variant) => variant.file === file) ?? null;
}

export function cockpitManifestIdentity(input: {
  base: string;
  name: string;
  locale: ManifestLocale;
  themeColor: string;
  revision: number;
  tenantIcon: boolean;
}) {
  const icon = (variant: IconVariant) => ({
    src: `${input.base}icon/${variant.file}?revision=${input.revision}`,
    sizes: `${variant.size}x${variant.size}`,
    type: "image/png",
    purpose: variant.purpose,
  });
  const icons = ICON_VARIANTS.filter(
    (variant) => variant.purpose === "any" || !input.tenantIcon,
  ).map(icon);
  const shortcutIcon = icons.find((entry) => entry.purpose === "any" && entry.sizes === "192x192");
  return {
    id: input.base,
    name: input.name,
    short_name: input.name,
    lang: input.locale,
    start_url: input.base,
    scope: input.base,
    display: "standalone",
    background_color: "#ffffff",
    theme_color: input.themeColor,
    categories: ["business", "productivity"],
    icons,
    shortcuts: SHORTCUTS.map((shortcut) => ({
      name: shortcut.name[input.locale],
      url: `${input.base}${shortcut.path}`,
      ...(shortcutIcon ? { icons: [{ ...shortcutIcon, purpose: "any" }] } : {}),
    })),
    protocol_handlers: [
      {
        protocol: COCKPIT_LINK_PROTOCOL,
        url: `${input.base}?${COCKPIT_LINK_PARAM}=%s`,
      },
    ],
    launch_handler: { client_mode: ["focus-existing", "auto"] },
  } as const;
}
