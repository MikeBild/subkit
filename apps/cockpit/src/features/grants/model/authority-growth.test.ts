import { describe, expect, test } from "bun:test";
import { growthLine } from "@/features/grants/model/authority-growth";
import { type TranslationKey, translate } from "@/lib/i18n";

const DEVICE = "66666666-6666-4666-8666-666666666666";

describe("growth on a new device", () => {
  for (const [locale, expected] of [
    ["de", "Neues Gerät: This Mac: files"],
    ["en", "New device: This Mac: files"],
  ] as const) {
    test(`names the device connector in ${locale}`, () => {
      const t = (key: TranslationKey, values?: Record<string, string | number>) =>
        translate(locale, key, values);
      expect(
        growthLine(t, [
          {
            kind: "new_device",
            connector_id: "c",
            connector_name: "This Mac: files",
            target: `device:${DEVICE}/files`,
            effect: "write",
            device_id: DEVICE,
          },
        ]),
      ).toBe(expected);
    });
  }
});

describe("growth inside an approved device", () => {
  const t = (key: TranslationKey, values?: Record<string, string | number>) =>
    translate("de", key, values);
  const line = (kind: string, item: string) =>
    growthLine(t, [
      {
        kind: kind as "new_folder",
        connector_id: "c",
        connector_name: "This Mac: files",
        target: `device:${DEVICE}/files`,
        effect: "write",
        device_id: DEVICE,
        item,
      },
    ]);

  test("names the folder, website or app, not the connector", () => {
    expect(line("new_folder", "~/Documents/Berichte")).toBe("Neuer Ordner: ~/Documents/Berichte");
    expect(line("wider_folder_access", "~/Documents/Berichte")).toBe(
      "Schreibt jetzt in Ordner: ~/Documents/Berichte",
    );
    expect(line("new_site", "https://shop.example")).toBe("Neue Website: https://shop.example");
    expect(line("private_site", "http://192.168.1.1")).toBe(
      "Neue private Adresse: http://192.168.1.1",
    );
    expect(line("new_app", "com.apple.Numbers")).toBe("Neue App: com.apple.Numbers");
    expect(line("new_secret", "crm-token")).toBe("Nutzt neu aus dem Tresor: crm-token");
    expect(line("new_model_call", "sub/classify")).toBe(
      "Schickt neu Daten aus Schritt sub/classify an das KI-Modell",
    );
  });
});
