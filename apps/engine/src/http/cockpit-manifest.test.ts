import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  COCKPIT_LINK_PARAM,
  COCKPIT_LINK_PROTOCOL,
  cockpitIconVariant,
  cockpitManifestIdentity,
} from "./cockpit-manifest.ts";

const base = "/cockpit/i/11111111-1111-4111-8111-111111111111/";
const identity = (overrides: Partial<Parameters<typeof cockpitManifestIdentity>[0]> = {}) =>
  cockpitManifestIdentity({
    base,
    name: "Acme Ops",
    locale: "de",
    themeColor: "#2563eb",
    revision: 4,
    tenantIcon: false,
    ...overrides,
  });

describe("installation manifest identity", () => {
  test("id, start address and scope are the installation path", () => {
    const manifest = identity();
    expect(manifest.id).toBe(base);
    expect(manifest.start_url).toBe(base);
    expect(manifest.scope).toBe(base);
    expect(manifest.display).toBe("standalone");
    expect(manifest.name).toBe("Acme Ops");
    expect(manifest.short_name).toBe("Acme Ops");
    expect(manifest.lang).toBe("de");
    expect(manifest.theme_color).toBe("#2563eb");
    expect(manifest.background_color).toBe("#ffffff");
  });

  test("everything it points to stays inside the installation path", () => {
    const manifest = identity();
    const addresses = [
      ...manifest.icons.map((icon) => icon.src),
      ...manifest.shortcuts.map((shortcut) => shortcut.url),
      ...manifest.shortcuts.flatMap((shortcut) => (shortcut.icons ?? []).map((icon) => icon.src)),
      ...manifest.protocol_handlers.map((handler) => handler.url),
    ];
    expect(addresses.length).toBeGreaterThan(8);
    for (const address of addresses) expect(address.startsWith(base), address).toBeTrue();
  });

  test("ships any, maskable and monochrome icons of the SubKit mark", () => {
    expect(identity().icons.map((icon) => `${icon.purpose} ${icon.sizes}`)).toEqual([
      "any 192x192",
      "any 512x512",
      "maskable 192x192",
      "maskable 512x512",
      "monochrome 512x512",
    ]);
    expect(identity().icons[0]?.src).toBe(`${base}icon/192.png?revision=4`);
    expect(identity().icons[3]?.src).toBe(`${base}icon/maskable-512.png?revision=4`);
  });

  test("a workspace icon is not passed off as maskable or monochrome", () => {
    expect(identity({ tenantIcon: true }).icons.map((icon) => icon.purpose)).toEqual([
      "any",
      "any",
    ]);
  });

  test("shortcuts open chat, tasks and inbox in the reader's language", () => {
    expect(identity().shortcuts.map((shortcut) => [shortcut.name, shortcut.url])).toEqual([
      ["Chat", `${base}chat`],
      ["Aufgaben", `${base}tasks`],
      ["Eingang", `${base}intake`],
    ]);
    expect(identity({ locale: "en" }).shortcuts.map((shortcut) => shortcut.name)).toEqual([
      "Chat",
      "Tasks",
      "Inbox",
    ]);
  });

  test("web+subkit links arrive as a parameter of the start address", () => {
    expect(COCKPIT_LINK_PROTOCOL).toBe("web+subkit");
    expect(identity().protocol_handlers).toEqual([
      { protocol: "web+subkit", url: `${base}?${COCKPIT_LINK_PARAM}=%s` },
    ]);
  });

  test("a second launch focuses the open window", () => {
    expect(identity().launch_handler).toEqual({ client_mode: ["focus-existing", "auto"] });
    expect(identity()).not.toHaveProperty("display_override");
  });
});

describe("icon files", () => {
  test("every manifest icon resolves to a generated file", () => {
    for (const icon of identity().icons) {
      const file = icon.src.slice(`${base}icon/`.length).split("?")[0];
      const variant = cockpitIconVariant(file);
      expect(variant, file).not.toBeNull();
      expect(
        existsSync(new URL(`../../../cockpit/public/${variant?.asset}`, import.meta.url)),
        variant?.asset,
      ).toBeTrue();
    }
  });

  test("unknown names resolve to nothing", () => {
    for (const file of [undefined, "", "1024.png", "512", "../512.png", "maskable-64.png"])
      expect(cockpitIconVariant(file)).toBeNull();
  });
});
