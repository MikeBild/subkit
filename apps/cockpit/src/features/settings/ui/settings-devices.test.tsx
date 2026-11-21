import { describe, expect, test } from "bun:test";
import {
  canRevokeDevice,
  type DeviceEntry,
  deviceRevocation,
  deviceRows,
} from "@/features/settings/model/settings-devices-model";
import { type TranslationKey, translate } from "@/lib/i18n";
import { render } from "../model/settings-fixtures";
import { DeviceList } from "./settings-devices";

const t = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);

const entries: DeviceEntry[] = [
  {
    id: "a1",
    kind: "browser",
    device_label: null,
    created_at: "2026-10-01T08:00:00.000Z",
    last_used_at: null,
    current: false,
  },
  {
    id: "b2",
    kind: "desktop",
    device_label: "Miras MacBook",
    created_at: "2026-11-02T08:00:00.000Z",
    last_used_at: "2026-11-19T08:00:00.000Z",
    current: true,
  },
  {
    id: "c3",
    kind: "desktop",
    device_label: " ",
    created_at: "2026-10-15T08:00:00.000Z",
    last_used_at: "2026-11-01T08:00:00.000Z",
    current: false,
  },
];

describe("devices of the signed-in person", () => {
  test("the asking device comes first, the others by sign-in date, each with a name", () => {
    expect(deviceRows(entries, t).map((row) => [row.id, row.name, row.current])).toEqual([
      ["b2", "Miras MacBook", true],
      ["a1", "Installierte Web-App", false],
      ["c3", "Desktop-Gerät", false],
    ]);
  });

  test("the confirmation names what happens to exactly this installation", () => {
    expect(deviceRevocation({ kind: "desktop", current: true })).toEqual({
      verb: "settings.devices.signOut",
      consequence: "settings.devices.consequence.current",
    });
    expect(deviceRevocation({ kind: "desktop", current: false }).consequence).toBe(
      "settings.devices.consequence.desktop",
    );
    expect(deviceRevocation({ kind: "browser", current: false }).consequence).toBe(
      "settings.devices.consequence.webApp",
    );
    expect(t("settings.devices.consequence.webApp")).toContain("Desktop-Geräte bleiben angemeldet");
    expect(t("installation.revokeConsequence")).toContain("Desktop-Geräte bleiben angemeldet");
    expect(translate("en", "installation.revokeConsequence")).toContain(
      "Desktop devices stay signed in",
    );
  });

  test("from an installed app only that app can be signed out", () => {
    expect(canRevokeDevice({ current: true }, true)).toBe(true);
    expect(canRevokeDevice({ current: false }, true)).toBe(false);
    expect(canRevokeDevice({ current: false }, false)).toBe(true);
  });

  test("the list shows kind, label, sign-in date, last use and the marker for this device", () => {
    const html = render(
      <DeviceList rows={deviceRows(entries, t)} askingFromDevice={false} onRevoke={() => {}} />,
    );
    expect(html).toContain('data-testid="settings-device-0"');
    expect(html).toMatch(/data-kind="desktop"[^>]*data-current="true"/);
    expect(html).toContain("Dieses Gerät");
    expect(html).toContain("Miras MacBook");
    expect(html).toContain("seit ");
    expect(html).toContain('<span class="sr-only">Desktop-App: </span>');
    expect(html).toContain("zuletzt genutzt");
    expect(html.match(/zuletzt genutzt/g)).toHaveLength(2);
    expect(html).toContain('data-testid="settings-device-revoke-0"');
    expect(html).toContain("Abmelden");
    expect(html).toContain("Widerrufen");
    const onDevice = render(
      <DeviceList rows={deviceRows(entries, t)} askingFromDevice onRevoke={() => {}} />,
    );
    expect(onDevice).toContain('data-testid="settings-device-revoke-0"');
    expect(onDevice).not.toContain('data-testid="settings-device-revoke-1"');
    expect(render(<DeviceList rows={[]} askingFromDevice={false} onRevoke={() => {}} />)).toContain(
      "Keine installierte App und kein Desktop-Gerät ist angemeldet.",
    );
  });
});
