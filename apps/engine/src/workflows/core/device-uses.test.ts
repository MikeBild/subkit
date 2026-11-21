import { describe, expect, test } from "bun:test";
import {
  type DeviceAllowanceView,
  deviceListsCanonical,
  deviceListsFor,
  deviceUsesOf,
} from "./device-uses.ts";

const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const D3 = "3".repeat(64);

const allowances: DeviceAllowanceView[] = [
  {
    kind: "folder",
    item_id: "rechnungen",
    display: "~/R",
    digest: D1,
    access: "read",
    private: null,
  },
  {
    kind: "folder",
    item_id: "berichte",
    display: "~/B",
    digest: D2,
    access: "write",
    private: null,
  },
  {
    kind: "site",
    item_id: "router",
    display: "http://192.168.1.1",
    digest: D3,
    access: null,
    private: true,
  },
  {
    kind: "site",
    item_id: "shop",
    display: "https://shop.example",
    digest: D1,
    access: null,
    private: false,
  },
  {
    kind: "app",
    item_id: "com.apple.Numbers",
    display: "Numbers",
    digest: D2,
    access: null,
    private: null,
  },
  {
    kind: "keep_out",
    item_id: "secret",
    display: "~/S",
    digest: null,
    access: null,
    private: null,
  },
];

describe("what a local step uses", () => {
  test("a file read names its folder for reading", () => {
    expect(deviceUsesOf({ method: "GET", body: { folder_id: "rechnungen" } }, "files")).toEqual({
      folders: [{ folder_id: "rechnungen", access: "read" }],
      origins: [],
      apps: [],
      dynamic: false,
    });
  });

  test("a write or move names every folder it touches for writing", () => {
    expect(
      deviceUsesOf(
        { method: "POST", body: { folder_id: "rechnungen", to_folder_id: "berichte" } },
        "files",
      ).folders,
    ).toEqual([
      { folder_id: "rechnungen", access: "write" },
      { folder_id: "berichte", access: "write" },
    ]);
  });

  test("a browser step names the origin of its address and a download folder", () => {
    expect(
      deviceUsesOf(
        { method: "POST", body: { url: "https://shop.example/orders?x=1", folder_id: "berichte" } },
        "browser",
      ),
    ).toEqual({
      folders: [{ folder_id: "berichte", access: "write" }],
      origins: ["https://shop.example"],
      apps: [],
      dynamic: false,
    });
  });

  test("a computer step names its app", () => {
    expect(
      deviceUsesOf({ method: "POST", body: { app_id: "com.apple.Numbers" } }, "computer").apps,
    ).toEqual(["com.apple.Numbers"]);
  });

  test("addresses and apps only count for their capability", () => {
    const uses = deviceUsesOf(
      { method: "POST", body: { url: "https://shop.example", app_id: "com.apple.Numbers" } },
      "files",
    );
    expect(uses.origins).toEqual([]);
    expect(uses.apps).toEqual([]);
  });

  test("a value filled at run time, or an address that is not a web address, cannot be bound", () => {
    for (const [body, capability] of [
      [{ folder_id: "${input.folder}" }, "files"],
      [{ url: "https://${input.host}/" }, "browser"],
      [{ url: "file:///etc/passwd" }, "browser"],
      [{ url: "not a url" }, "browser"],
      [{ app_id: "${input.app}" }, "computer"],
    ] as const)
      expect(deviceUsesOf({ method: "POST", body }, capability).dynamic).toBe(true);
  });

  test("a step without a body or with empty values uses nothing", () => {
    expect(deviceUsesOf({ method: "GET" }, "files")).toEqual({
      folders: [],
      origins: [],
      apps: [],
      dynamic: false,
    });
    expect(
      deviceUsesOf({ method: "GET", body: { folder_id: "", url: 3 } }, "browser").folders,
    ).toEqual([]);
  });
});

describe("the lists an approval names", () => {
  test("allowed folders, sites and apps get their digests, sorted", () => {
    expect(
      deviceListsFor(
        {
          folders: [
            { folder_id: "rechnungen", access: "read" },
            { folder_id: "berichte", access: "write" },
          ],
          origins: ["https://shop.example", "http://192.168.1.1"],
          apps: ["com.apple.Numbers"],
          dynamic: false,
        },
        allowances,
      ),
    ).toEqual({
      complete: true,
      lists: {
        folders: [
          { folder_id: "berichte", access: "write", root_digest: D2 },
          { folder_id: "rechnungen", access: "read", root_digest: D1 },
        ],
        sites: [
          { origin: "http://192.168.1.1", private: true, site_digest: D3 },
          { origin: "https://shop.example", private: false, site_digest: D1 },
        ],
        apps: [{ app_id: "com.apple.Numbers", app_digest: D2 }],
      },
    });
  });

  test("a folder used twice is named once, with the wider access", () => {
    const resolved = deviceListsFor(
      {
        folders: [
          { folder_id: "berichte", access: "write" },
          { folder_id: "berichte", access: "read" },
        ],
        origins: [],
        apps: [],
        dynamic: false,
      },
      allowances,
    );
    expect(resolved.lists.folders).toEqual([
      { folder_id: "berichte", access: "write", root_digest: D2 },
    ]);
  });

  test("nothing used names no lists at all, so older digests keep their shape", () => {
    expect(deviceListsFor({ folders: [], origins: [], apps: [], dynamic: false }, [])).toEqual({
      complete: true,
      lists: {},
    });
  });

  test("anything the device does not allow keeps the approval incomplete", () => {
    const none = { folders: [], origins: [], apps: [], dynamic: false };
    for (const uses of [
      { ...none, folders: [{ folder_id: "rechnungen", access: "write" as const }] },
      { ...none, folders: [{ folder_id: "secret", access: "read" as const }] },
      { ...none, folders: [{ folder_id: "unknown", access: "read" as const }] },
      { ...none, origins: ["https://other.example"] },
      { ...none, apps: ["com.example.Other"] },
      { ...none, dynamic: true },
    ])
      expect(deviceListsFor(uses, allowances).complete).toBe(false);
  });

  test("a list must be sorted, without repeats and not empty", () => {
    const folder = (folder_id: string) => ({ folder_id, access: "read" as const, root_digest: D1 });
    expect(deviceListsCanonical({})).toBe(true);
    expect(deviceListsCanonical({ folders: [folder("a"), folder("b")] })).toBe(true);
    expect(deviceListsCanonical({ folders: [folder("b"), folder("a")] })).toBe(false);
    expect(deviceListsCanonical({ folders: [folder("a"), folder("a")] })).toBe(false);
    expect(deviceListsCanonical({ folders: [] })).toBe(false);
    const site = (origin: string) => ({ origin, private: false, site_digest: D1 });
    expect(deviceListsCanonical({ sites: [site("https://a"), site("https://b")] })).toBe(true);
    expect(deviceListsCanonical({ sites: [site("https://b"), site("https://a")] })).toBe(false);
    expect(deviceListsCanonical({ sites: [] })).toBe(false);
    const app = (app_id: string) => ({ app_id, app_digest: D1 });
    expect(deviceListsCanonical({ apps: [app("a"), app("b")] })).toBe(true);
    expect(deviceListsCanonical({ apps: [app("b"), app("a")] })).toBe(false);
    expect(deviceListsCanonical({ apps: [] })).toBe(false);
  });

  describe("matching a step to the device's allowances", () => {
    const none = { folders: [], origins: [], apps: [], dynamic: false };

    test("a plain http address counts as a website", () => {
      expect(
        deviceUsesOf({ method: "GET", body: { url: "http://192.168.1.1/admin" } }, "browser")
          .origins,
      ).toEqual(["http://192.168.1.1"]);
    });

    test("an allowance of another kind with the same name does not count", () => {
      const appNamedLikeFolder: DeviceAllowanceView[] = [
        {
          kind: "app",
          item_id: "berichte",
          display: "Berichte",
          digest: D1,
          access: "write",
          private: null,
        },
      ];
      expect(
        deviceListsFor(
          { ...none, folders: [{ folder_id: "berichte", access: "read" }] },
          appNamedLikeFolder,
        ).complete,
      ).toBe(false);
      const folderNamedLikeSite: DeviceAllowanceView[] = [
        {
          kind: "folder",
          item_id: "f",
          display: "https://shop.example",
          digest: D1,
          access: "read",
          private: null,
        },
      ];
      expect(
        deviceListsFor({ ...none, origins: ["https://shop.example"] }, folderNamedLikeSite)
          .complete,
      ).toBe(false);
    });

    test("several apps are each named once, sorted", () => {
      const two: DeviceAllowanceView[] = [
        { kind: "app", item_id: "com.b", display: "B", digest: D1, access: null, private: null },
        { kind: "app", item_id: "com.a", display: "A", digest: D2, access: null, private: null },
      ];
      expect(
        deviceListsFor({ ...none, apps: ["com.b", "com.a", "com.b"] }, two).lists.apps,
      ).toEqual([
        { app_id: "com.a", app_digest: D2 },
        { app_id: "com.b", app_digest: D1 },
      ]);
    });
  });
});

describe("folder access follows what the step does", () => {
  const body = { folder_id: "rechnungen" };
  test("GET and imports read; other methods write", () => {
    const access = (step: { method: string; path?: string }) =>
      deviceUsesOf({ ...step, body }, "files").folders[0]?.access;
    expect(access({ method: "GET", path: "/files.list" })).toBe("read");
    expect(access({ method: "POST", path: "/files.import" })).toBe("read");
    expect(access({ method: "POST", path: "files.import" })).toBe("read");
    expect(access({ method: "POST", path: "/files.write" })).toBe("write");
    expect(access({ method: "POST", path: "//files.import" })).toBe("read");
    expect(access({ method: "POST", path: "//files.import/x" })).toBe("write");
    expect(access({ method: "POST", path: "files.import/" })).toBe("write");
    expect(access({ method: "POST" })).toBe("write");
  });
});
