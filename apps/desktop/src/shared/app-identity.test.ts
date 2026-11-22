import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DMG_WINDOW,
  dmgBackgroundSvg,
  glyphOf,
  macIconSvg,
  RENDERED,
  TRAY_POINTS,
  traySvg,
} from "../../scripts/icons.ts";
import {
  aboutPanel,
  COPYRIGHT,
  ELECTRON_USAGE_KEYS_REMOVED,
  INFO_PLIST_LOCALES,
  infoPlistStrings,
  MIN_MACOS,
  USAGE_DESCRIPTIONS,
  WEBSITE,
} from "./app-identity.ts";
import { CHANNELS } from "./channel.ts";

const app = join(import.meta.dir, "..", "..");
const assets = join(app, "assets");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

interface Resource {
  from: string;
  to: string;
}

interface BaseConfig {
  copyright: string;
  mac: {
    category: string;
    icon: string;
    minimumSystemVersion: string;
    hardenedRuntime: boolean;
    entitlements: string;
    entitlementsInherit: string;
    extendInfo: Record<string, unknown>;
    extraResources: Resource[];
    extraFiles: Resource[];
    signIgnore: string[];
  };
  win: { icon: string };
  dmg: {
    icon: string;
    background: string;
    window: { width: number; height: number };
    contents: { x: number; y: number; type: string; path?: string }[];
  };
}

interface ChannelConfig {
  appId: string;
  productName: string;
  protocols: { name: string; schemes: string[] };
}

const baseText = read(join(app, "electron-builder.base.yml"));
const base = Bun.YAML.parse(baseText) as BaseConfig;
const production = Bun.YAML.parse(read(join(app, "electron-builder.yml"))) as ChannelConfig;
const development = Bun.YAML.parse(read(join(app, "electron-builder.dev.yml"))) as ChannelConfig;
const info = base.mac.extendInfo;

describe("Info.plist of the macOS app", () => {
  test("asks only for the places the app really reaches", () => {
    const asked = Object.entries(info)
      .filter(([key, value]) => key.endsWith("UsageDescription") && value !== null)
      .map(([key]) => key)
      .sort();
    expect(asked).toEqual(
      [
        "NSDesktopFolderUsageDescription",
        "NSDocumentsFolderUsageDescription",
        "NSDownloadsFolderUsageDescription",
        "NSLocalNetworkUsageDescription",
        "NSNetworkVolumesUsageDescription",
        "NSRemovableVolumesUsageDescription",
      ].sort(),
    );
    expect(Object.keys(USAGE_DESCRIPTIONS).sort()).toEqual(asked);
  });

  test("the English defaults are the strings of the identity module", () => {
    for (const [key, text] of Object.entries(USAGE_DESCRIPTIONS)) expect(info[key]).toBe(text.en);
  });

  test("drops Electron's generic purpose strings and claims no Apple Events", () => {
    for (const key of ELECTRON_USAGE_KEYS_REMOVED) expect(info[key]).toBeNull();
    for (const key of ["NSAppleEventsUsageDescription", "NSScreenCaptureUsageDescription"])
      expect(info).not.toHaveProperty(key);
  });

  test("every purpose string is one sentence, German says du", () => {
    for (const text of Object.values(USAGE_DESCRIPTIONS)) {
      for (const sentence of [text.de, text.en]) {
        expect(sentence).toMatch(/^SubKit [^.!?]+\.$/);
      }
      expect(text.de).toMatch(/\b(du|dein\w*)\b/);
      expect(text.de).not.toMatch(/\b(Sie|Ihr\w*)\b/);
      expect(text.en).not.toContain("!");
    }
  });

  test("names, copyright, category and system version", () => {
    expect(info.NSHumanReadableCopyright).toBe(COPYRIGHT);
    expect(COPYRIGHT).toMatch(/^© 20\d\d Mike Bild$/);
    expect(info.CFBundleDevelopmentRegion).toBe("en");
    expect(info.LSHasLocalizedDisplayName).toBe(true);
    expect(base.mac.category).toBe("public.app-category.productivity");
    expect(base.mac.minimumSystemVersion).toBe(MIN_MACOS);
  });

  test("ships German and English InfoPlist.strings", () => {
    expect(INFO_PLIST_LOCALES).toEqual(["de", "en"]);
    for (const locale of INFO_PLIST_LOCALES) {
      expect(base.mac.extraResources).toContainEqual({
        from: `dist/mac/${locale}.lproj/InfoPlist.strings`,
        to: `${locale}.lproj/InfoPlist.strings`,
      });
    }
  });

  test("the strings files localize the name and every purpose string", () => {
    const keysOf = (text: string) => [...text.matchAll(/^(\w+) = "/gm)].map((match) => match[1]);
    const expected = ["CFBundleDisplayName", "CFBundleName", ...Object.keys(USAGE_DESCRIPTIONS)];
    for (const locale of INFO_PLIST_LOCALES) {
      const text = infoPlistStrings(locale, CHANNELS.production.name);
      expect(keysOf(text)).toEqual(expected);
      expect(text).toContain('CFBundleDisplayName = "SubKit";');
      for (const line of text.trim().split("\n")) expect(line).toMatch(/^\w+ = ".*";$/);
    }
    expect(infoPlistStrings("de", CHANNELS.development.name)).toContain(
      'CFBundleDisplayName = "SubKit Dev";',
    );
    expect(infoPlistStrings("en", 'Say "hi"')).toContain('CFBundleName = "Say \\"hi\\"";');
  });
});

describe("bundle identity", () => {
  test("keeps the bundle ids and schemes of both channels", () => {
    expect(production.appId).toBe(CHANNELS.production.appId);
    expect(production.appId).toBe("dev.mikebild.subkit.desktop");
    expect(production.productName).toBe("SubKit");
    expect(production.protocols.schemes).toEqual([CHANNELS.production.scheme]);
    expect(development.appId).toBe(CHANNELS.development.appId);
    expect(development.productName).toBe("SubKit Dev");
    expect(development.protocols.schemes).toEqual([CHANNELS.development.scheme]);
  });

  test("the package names the product", () => {
    const pkg = JSON.parse(read(join(app, "package.json"))) as { productName: string };
    expect(pkg.productName).toBe(CHANNELS.production.name);
  });

  test("the About panel names version, copyright, website and the notices", () => {
    for (const locale of INFO_PLIST_LOCALES) {
      const panel = aboutPanel(locale, "SubKit", "11.2.0");
      expect(panel.applicationName).toBe("SubKit");
      expect(panel.applicationVersion).toBe("11.2.0");
      expect(panel.copyright).toBe(COPYRIGHT);
      expect(panel.website).toBe(WEBSITE);
      expect(panel.credits).toContain("subkit.mikebild.dev");
      expect(panel.credits).toContain("THIRD_PARTY_NOTICES.txt");
    }
    expect(WEBSITE).toBe("https://subkit.mikebild.dev");
  });
});

describe("entitlements of the macOS app", () => {
  test("hardened runtime with the JIT entitlement and nothing more", () => {
    expect(base.mac.hardenedRuntime).toBe(true);
    expect(base.mac.entitlements).toBe("assets/entitlements.mac.plist");
    expect(base.mac.entitlementsInherit).toBe("assets/entitlements.mac.plist");
    const plist = read(join(app, base.mac.entitlements));
    expect(plist.match(/<key>[^<]+<\/key>/g)).toEqual([
      "<key>com.apple.security.cs.allow-jit</key>",
    ]);
  });

  test("the bundled helper tools are presigned without entitlements and left unsigned by the build", () => {
    expect(base.mac.extraFiles.map((file) => file.to)).toContain("Helpers/agent-desktop");
    expect(base.mac.extraResources.map((file) => file.to)).toContain("agent-browser");
    expect(base.mac.signIgnore).toEqual([
      "/Contents/Helpers/agent-desktop/",
      "/Contents/Resources/agent-browser/",
      "/Contents/Resources/local/postgres/",
    ]);
  });

  test("no configuration weakens library validation or executable memory", () => {
    for (const file of [
      "electron-builder.base.yml",
      "electron-builder.yml",
      "electron-builder.dev.yml",
    ]) {
      const text = read(join(app, file));
      expect(text).not.toContain("disable-library-validation");
      expect(text).not.toContain("allow-unsigned-executable-memory");
    }
  });
});

function pngSize(path: string): [number, number] {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function icnsTypes(path: string): string[] {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("icns");
  expect(bytes.readUInt32BE(4)).toBe(bytes.length);
  const types: string[] = [];
  for (let offset = 8; offset < bytes.length; offset += bytes.readUInt32BE(offset + 4)) {
    types.push(bytes.subarray(offset, offset + 4).toString("latin1"));
  }
  return types;
}

describe("icons", () => {
  const glyph = glyphOf(read(join(app, "../cockpit/public/favicon.svg")));

  test("the macOS app and DMG use the icns with every size from 16 to 1024", () => {
    expect(base.mac.icon).toBe("assets/icon.icns");
    expect(base.dmg.icon).toBe("assets/icon.icns");
    const types = icnsTypes(join(assets, "icon.icns")).filter((type) => type !== "info");
    expect(types.sort()).toEqual(
      ["ic04", "ic05", "ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"].sort(),
    );
  });

  test("Windows keeps the PNG icon", () => {
    expect(base.win.icon).toBe("assets/icon.png");
    expect(pngSize(join(assets, "icon.png"))).toEqual([512, 512]);
  });

  test("the rendered files have their sizes", () => {
    for (const [file, width, height] of RENDERED)
      expect([file, ...pngSize(join(assets, file))]).toEqual([file, width, height]);
  });

  test("the menu bar image is a template at 1x and 2x", () => {
    expect(TRAY_POINTS).toBe(18);
    expect(RENDERED.map(([file]) => file)).toContain("trayTemplate.png");
    expect(RENDERED.map(([file]) => file)).toContain("trayTemplate@2x.png");
    expect(traySvg(glyph)).toContain('stroke="#000"');
  });

  test("the DMG has a background at 1x and 2x and links to Applications", () => {
    expect(base.dmg.background).toBe("assets/dmg-background.png");
    expect(base.dmg.window).toEqual({ width: DMG_WINDOW.width, height: DMG_WINDOW.height });
    expect(base.dmg.contents).toEqual([
      { x: DMG_WINDOW.appX, y: DMG_WINDOW.iconY, type: "file" },
      { x: DMG_WINDOW.linkX, y: DMG_WINDOW.iconY, type: "link", path: "/Applications" },
    ]);
  });

  test("the committed sources come from the SubKit mark of the Cockpit", () => {
    expect(read(join(assets, "icon-mac.svg"))).toBe(macIconSvg(glyph));
    expect(read(join(assets, "tray.svg"))).toBe(traySvg(glyph));
    expect(read(join(assets, "dmg-background.svg"))).toBe(dmgBackgroundSvg());
  });

  test("the app icon sits on the macOS grid", () => {
    const svg = macIconSvg(glyph);
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).toContain('<rect x="100" y="100" width="824" height="824" rx="185.4"');
  });
});

describe("helper apps", () => {
  const { renameHelper } = require("../../scripts/after-pack.cjs") as {
    renameHelper(plist: string, productName: string): string;
  };
  const plist = (name: string) =>
    `<dict>\n    <key>CFBundleName</key>\n    <string>${name}</string>\n    <key>CFBundleIdentifier</key>\n    <string>dev.mikebild.subkit.desktop.helper</string>\n</dict>`;

  test("the packed helpers carry the product name, not Electron", () => {
    expect(Bun.YAML.parse(baseText)).toHaveProperty("afterPack", "scripts/after-pack.cjs");
    expect(renameHelper(plist("Electron Helper (Renderer)"), "SubKit")).toBe(
      plist("SubKit Helper (Renderer)"),
    );
    expect(renameHelper(plist("Electron Helper"), "SubKit Dev")).toBe(plist("SubKit Dev Helper"));
    expect(renameHelper(plist("SubKit Helper"), "SubKit")).toBe(plist("SubKit Helper"));
  });
});
