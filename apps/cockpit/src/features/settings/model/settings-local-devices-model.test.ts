import { describe, expect, test } from "bun:test";
import type { DeviceListItem } from "@/api/devices";
import { translatePlural } from "@/lib/i18n";
import {
  capabilitiesOf,
  countsLine,
  deviceScope,
  localDeviceRows,
} from "./settings-local-devices-model";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function device(change: Partial<DeviceListItem>): DeviceListItem {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    device_label: "MacBook Pro (Mike)",
    owner_user_id: ME,
    enrolled_at: "2026-11-21T08:00:00.000Z",
    last_heartbeat_at: "2026-11-21T09:00:00.000Z",
    online: true,
    capabilities: { os: "darwin", capabilities: ["files", "computer", "teleport"] },
    app_version: "11.3.0",
    allowance_counts: { folder: 2, site: 1, app: 0, keep_out: 4 },
    is_this_installation: false,
    ...change,
  };
}

describe("devices for local steps", () => {
  test("an admin lists every device of the workspace, everybody else only their own", () => {
    expect(deviceScope(["device:read", "device:revoke_any"])).toBe("all");
    expect(deviceScope(["device:read", "device:manage"])).toBe("own");
  });

  test("only the capabilities the protocol knows are shown, in protocol order", () => {
    expect(capabilitiesOf({ capabilities: ["computer", "files", "teleport"] })).toEqual([
      "files",
      "computer",
    ]);
    expect(capabilitiesOf({})).toEqual([]);
    expect(capabilitiesOf({ capabilities: "files" })).toEqual([]);
  });

  test("the asking installation comes first", () => {
    const rows = localDeviceRows(
      [
        device({ id: "a", device_label: "Alpha" }),
        device({ id: "z", device_label: "Zulu", is_this_installation: true }),
      ],
      ME,
      "x",
    );
    expect(rows.map((row) => [row.id, row.here])).toEqual([
      ["z", true],
      ["a", false],
    ]);
  });

  test("own devices come first, then online ones, then by name", () => {
    const rows = localDeviceRows(
      [
        device({ id: "b", device_label: "Zeta", owner_user_id: OTHER }),
        device({ id: "c", device_label: "Beta", online: false }),
        device({ id: "a", device_label: "  " }),
      ],
      ME,
      "Desktop device",
    );
    expect(rows.map((row) => [row.id, row.name, row.own, row.online])).toEqual([
      ["a", "Desktop device", true, true],
      ["c", "Beta", true, false],
      ["b", "Zeta", false, true],
    ]);
  });

  test("a row counts folders, websites and apps but never keeps a path", () => {
    const [row] = localDeviceRows([device({})], ME, "x");
    expect(row?.counts).toEqual({ folder: 2, site: 1, app: 0 });
    expect(JSON.stringify(row)).not.toContain("~/");
  });

  test("the counts read with the right plural in both languages", () => {
    const counts = { folder: 1, site: 2, app: 1 };
    expect(countsLine(counts, (key, count) => translatePlural("de", key, count))).toBe(
      "1 Ordner · 2 Websites · 1 App",
    );
    expect(countsLine(counts, (key, count) => translatePlural("en", key, count))).toBe(
      "1 folder · 2 websites · 1 app",
    );
  });
});
