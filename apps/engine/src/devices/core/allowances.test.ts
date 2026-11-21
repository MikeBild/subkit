import { describe, expect, test } from "bun:test";
import type { DeviceAllowance } from "@shared/device/boundary.ts";
import {
  ALLOWANCE_AUDIT_ACTIONS,
  type AllowanceRow,
  allowanceRow,
  DEVICE_ALLOWANCES_MAX,
  diffAllowances,
} from "./allowances.ts";

const D1 = "1".repeat(64);
const D2 = "2".repeat(64);

const folder: DeviceAllowance = {
  kind: "folder",
  id: "f1",
  display: "~/Documents/Rechnungen",
  access: "read",
  digest: D1,
  entered_by: "person",
};
const site: DeviceAllowance = {
  kind: "site",
  id: "s1",
  origin: "http://192.168.1.10:8080",
  private: true,
  digest: D2,
  entered_by: "person",
};
const app: DeviceAllowance = {
  kind: "app",
  id: "com.apple.iWork.Numbers",
  display: "Numbers",
  digest: D1,
  entered_by: "approval",
};
const keepOut: DeviceAllowance = {
  kind: "keep_out",
  id: "k1",
  target: "folder",
  display: "~/Private",
  entered_by: "person",
};

describe("mirroring the allowances of a device", () => {
  test("each kind becomes one row", () => {
    expect(allowanceRow(folder)).toEqual({
      kind: "folder",
      item_id: "f1",
      display: "~/Documents/Rechnungen",
      digest: D1,
      access: "read",
      private: null,
      keep_out_target: null,
      entered_by: "person",
    });
    expect(allowanceRow(site)).toEqual({
      kind: "site",
      item_id: "s1",
      display: "http://192.168.1.10:8080",
      digest: D2,
      access: null,
      private: true,
      keep_out_target: null,
      entered_by: "person",
    });
    expect(allowanceRow(app)).toEqual({
      kind: "app",
      item_id: "com.apple.iWork.Numbers",
      display: "Numbers",
      digest: D1,
      access: null,
      private: null,
      keep_out_target: null,
      entered_by: "approval",
    });
    expect(allowanceRow(keepOut)).toEqual({
      kind: "keep_out",
      item_id: "k1",
      display: "~/Private",
      digest: null,
      access: null,
      private: null,
      keep_out_target: "folder",
      entered_by: "person",
    });
  });

  test("an unchanged list changes nothing", () => {
    const current = [folder, site, app, keepOut].map(allowanceRow);
    expect(diffAllowances(current, [keepOut, app, site, folder])).toEqual({
      ok: true,
      added: [],
      removed: [],
    });
  });

  test("new and missing entries are added and removed", () => {
    expect(diffAllowances([allowanceRow(folder)], [site])).toEqual({
      ok: true,
      added: [allowanceRow(site)],
      removed: [allowanceRow(folder)],
    });
  });

  test("a changed entry is removed and added again, so audit shows both", () => {
    const widened: DeviceAllowance = { ...folder, access: "write" };
    expect(diffAllowances([allowanceRow(folder)], [widened])).toEqual({
      ok: true,
      added: [allowanceRow(widened)],
      removed: [allowanceRow(folder)],
    });
    const fields: Array<[DeviceAllowance, DeviceAllowance]> = [
      [folder, { ...folder, display: "~/Documents/Other" }],
      [folder, { ...folder, digest: D2 }],
      [folder, { ...folder, entered_by: "approval" }],
      [site, { ...site, private: false }],
      [keepOut, { ...keepOut, target: "app" }],
    ];
    for (const [before, after] of fields) {
      const diff = diffAllowances([allowanceRow(before)], [after]);
      expect(diff).toEqual({
        ok: true,
        added: [allowanceRow(after)],
        removed: [allowanceRow(before)],
      });
    }
  });

  test("the same item under two kinds is two entries", () => {
    const appNamedLikeFolder: DeviceAllowance = { ...app, id: "f1" };
    const diff = diffAllowances([], [folder, appNamedLikeFolder]);
    expect(diff.ok && diff.added.length).toBe(2);
  });

  test("a duplicate or an oversized list is refused as a whole", () => {
    expect(diffAllowances([], [folder, { ...folder, display: "again" }])).toEqual({
      ok: false,
      code: "allowances_duplicate",
    });
    const many = Array.from({ length: DEVICE_ALLOWANCES_MAX + 1 }, (_, i) => ({
      ...folder,
      id: `f${i}`,
    }));
    expect(diffAllowances([], many)).toEqual({ ok: false, code: "allowances_too_many" });
    expect(diffAllowances([], many.slice(0, DEVICE_ALLOWANCES_MAX)).ok).toBe(true);
  });

  test("every change of every kind has its audit action", () => {
    const kinds: AllowanceRow["kind"][] = ["folder", "site", "app", "keep_out"];
    for (const kind of kinds) {
      expect(ALLOWANCE_AUDIT_ACTIONS.added[kind]).toMatch(/^device\./);
      expect(ALLOWANCE_AUDIT_ACTIONS.removed[kind]).toMatch(/^device\./);
    }
  });

  test("a private address counts only when the person typed it on the device", () => {
    expect(diffAllowances([], [{ ...site, entered_by: "approval" }])).toEqual({
      ok: false,
      code: "private_site_needs_person",
    });
    const publicSite: DeviceAllowance = { ...site, private: false, entered_by: "approval" };
    expect(diffAllowances([], [publicSite]).ok).toBe(true);
  });
});
