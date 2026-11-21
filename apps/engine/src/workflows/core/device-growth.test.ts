import { describe, expect, test } from "bun:test";
import { deviceGrowth } from "./device-growth.ts";
import { deviceListsFor, deviceUsesOf } from "./device-uses.ts";
import type { DeviceBinding } from "./effect-manifest.ts";

const MAC = "66666666-6666-4666-8666-666666666666";
const OTHER = "77777777-7777-4777-8777-777777777777";
const D1 = "1".repeat(64);
const D2 = "2".repeat(64);

const granted: DeviceBinding = {
  device_id: MAC,
  capability: "files",
  folders: [
    { folder_id: "berichte", access: "read", root_digest: D1 },
    { folder_id: "rechnungen", access: "write", root_digest: D1 },
  ],
  sites: [{ origin: "https://shop.example", private: false, site_digest: D1 }],
  apps: [{ app_id: "com.apple.Numbers", app_digest: D1 }],
};

function next(patch: Partial<DeviceBinding>): DeviceBinding {
  return { device_id: MAC, capability: "files", ...patch };
}

describe("growth inside an approved device", () => {
  test("the same or fewer folders, sites and apps carry the approval forward", () => {
    expect(deviceGrowth(granted, [granted])).toEqual([]);
    expect(deviceGrowth(next({}), [granted])).toEqual([]);
    expect(
      deviceGrowth(
        next({ folders: [{ folder_id: "rechnungen", access: "read", root_digest: D1 }] }),
        [granted],
      ),
    ).toEqual([]);
  });

  test("a new folder, or the same path replaced by another folder, is new_folder", () => {
    expect(
      deviceGrowth(next({ folders: [{ folder_id: "neu", access: "read", root_digest: D1 }] }), [
        granted,
      ]),
    ).toEqual([{ kind: "new_folder", item: "neu" }]);
    expect(
      deviceGrowth(
        next({ folders: [{ folder_id: "berichte", access: "read", root_digest: D2 }] }),
        [granted],
      ),
    ).toEqual([{ kind: "new_folder", item: "berichte" }]);
  });

  test("writing where only reading was approved is wider_folder_access", () => {
    expect(
      deviceGrowth(
        next({ folders: [{ folder_id: "berichte", access: "write", root_digest: D1 }] }),
        [granted],
      ),
    ).toEqual([{ kind: "wider_folder_access", item: "berichte" }]);
    const alsoWrite = next({
      folders: [{ folder_id: "berichte", access: "write", root_digest: D1 }],
    });
    expect(deviceGrowth(alsoWrite, [granted, alsoWrite])).toEqual([]);
  });

  test("a new website is new_site, a new private address is private_site", () => {
    expect(
      deviceGrowth(
        next({
          sites: [
            { origin: "http://192.168.1.1", private: true, site_digest: D1 },
            { origin: "https://news.example", private: false, site_digest: D1 },
            { origin: "https://shop.example", private: false, site_digest: D2 },
          ],
        }),
        [granted],
      ),
    ).toEqual([
      { kind: "private_site", item: "http://192.168.1.1" },
      { kind: "new_site", item: "https://news.example" },
      { kind: "new_site", item: "https://shop.example" },
    ]);
  });

  test("a new app, or the same app signed by someone else, is new_app", () => {
    expect(
      deviceGrowth(
        next({
          apps: [
            { app_id: "com.apple.Numbers", app_digest: D2 },
            { app_id: "com.apple.Pages", app_digest: D1 },
          ],
        }),
        [granted],
      ),
    ).toEqual([
      { kind: "new_app", item: "com.apple.Numbers" },
      { kind: "new_app", item: "com.apple.Pages" },
    ]);
  });

  test("lists approved for another device do not count", () => {
    expect(
      deviceGrowth(
        next({ folders: [{ folder_id: "berichte", access: "read", root_digest: D1 }] }),
        [{ ...granted, device_id: OTHER }],
      ),
    ).toEqual([{ kind: "new_folder", item: "berichte" }]);
  });

  test("a site or app is covered when any approved one matches", () => {
    const wide: DeviceBinding = {
      ...granted,
      sites: [
        { origin: "https://a.example", private: false, site_digest: D1 },
        { origin: "https://b.example", private: false, site_digest: D1 },
      ],
      apps: [
        { app_id: "com.a", app_digest: D1 },
        { app_id: "com.b", app_digest: D1 },
      ],
    };
    expect(
      deviceGrowth(
        next({
          sites: [{ origin: "https://b.example", private: false, site_digest: D1 }],
          apps: [{ app_id: "com.b", app_digest: D1 }],
        }),
        [undefined, wide],
      ),
    ).toEqual([]);
  });
});

describe("importing from a folder", () => {
  const allowances = [
    {
      kind: "folder" as const,
      item_id: "berichte",
      display: "~/B",
      digest: D1,
      access: "read" as const,
      private: null,
    },
  ];
  const bound = (step: { method: string; path: string }) => ({
    device_id: MAC,
    capability: "files" as const,
    ...deviceListsFor(
      deviceUsesOf({ ...step, body: { folder_id: "berichte" } }, "files"),
      allowances,
    ).lists,
  });

  test("an import needs only read, so read then import is no growth", () => {
    const read = bound({ method: "GET", path: "/files.read_text" });
    const imported = bound({ method: "POST", path: "/files.import" });
    expect(imported.folders).toEqual([{ folder_id: "berichte", access: "read", root_digest: D1 }]);
    expect(deviceGrowth(imported, [read])).toEqual([]);
  });
});
