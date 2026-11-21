import { describe, expect, test } from "bun:test";
import type { LocalBridge } from "../../shared/ipc.ts";
import {
  createLocalCapabilities,
  createMockLocalCapabilities,
  deviceBridgeOf,
} from "./local-capabilities.ts";

const folder = {
  id: "fld_1",
  kind: "folder" as const,
  display: "~/A",
  access: "write" as const,
  status: null,
  private: false,
};

function bridge(calls: unknown[]): LocalBridge {
  const view = { personal_enabled: true, items: [folder] };
  return {
    pickFolder: (options) => {
      calls.push(["pick", options]);
      return Promise.resolve({ status: "added", id: "fld_1", view });
    },
    listAllowances: () => Promise.resolve(view),
    removeAllowance: (id) => {
      calls.push(["remove", id]);
      return Promise.resolve({ personal_enabled: true, items: [] });
    },
    setAccess: (id, access) => {
      calls.push(["access", id, access]);
      return Promise.resolve(view);
    },
    setPersonalEnabled: (enabled) => Promise.resolve({ personal_enabled: enabled, items: [] }),
    addSite: (origin) => {
      calls.push(["site", origin]);
      return Promise.resolve(view);
    },
    addApp: () => {
      calls.push(["app"]);
      return Promise.resolve({ status: "added", id: "com.apple.Numbers", view });
    },
  };
}

describe("local capabilities port", () => {
  test("uses the device bridge only when it offers every method", () => {
    expect(deviceBridgeOf({ local: bridge([]) })).not.toBeNull();
    expect(deviceBridgeOf({ local: { pickFolder() {} } })).toBeNull();
    expect(deviceBridgeOf({})).toBeNull();
    expect(deviceBridgeOf(undefined)).toBeNull();
  });

  test("passes the chosen access to the native picker and reads the answer as allowances", async () => {
    const calls: unknown[] = [];
    const port = createLocalCapabilities({ local: bridge(calls) });
    expect(await port.pickFolder({ access: "write", keepOut: false })).toEqual({
      status: "added",
      id: "fld_1",
      view: {
        enabled: true,
        items: [{ kind: "folder", id: "fld_1", display: "~/A", access: "write" }],
      },
    });
    await port.removeAllowance("fld_1");
    expect(calls).toEqual([
      ["pick", { access: "write", keepOut: false }],
      ["remove", "fld_1"],
    ]);
  });

  test("websites and apps are stored on the device and read back as allowances", async () => {
    const calls: unknown[] = [];
    const port = createLocalCapabilities({ local: bridge(calls) });
    expect(await port.addSite?.("https://shop.example.com")).toEqual({
      enabled: true,
      items: [{ kind: "folder", id: "fld_1", display: "~/A", access: "write" }],
    });
    expect(await port.addApp?.()).toMatchObject({ status: "added", id: "com.apple.Numbers" });
    expect(calls).toEqual([["site", "https://shop.example.com"], ["app"]]);
  });

  test("without a device bridge a mock starts empty and keeps an origin once", async () => {
    const port = createLocalCapabilities(undefined);
    expect(await port.listAllowances()).toEqual({ enabled: false, items: [] });
    const add = port.addSite;
    if (!add) throw new Error("the mock stores websites");
    await add("https://Example.com:443");
    const view = await add("https://example.com");
    expect(view.items).toEqual([
      { kind: "site", id: "site_1", origin: "https://example.com", private: false },
    ]);
    expect((await port.removeAllowance("site_1")).items).toEqual([]);
    expect(
      await createMockLocalCapabilities().pickFolder({ access: "read", keepOut: false }),
    ).toEqual({ status: "cancelled" });
  });

  test("changing a folder's access per row goes through the device", async () => {
    const calls: unknown[] = [];
    const change = createLocalCapabilities({ local: bridge(calls) }).setAccess;
    if (!change) throw new Error("the bridge offers setAccess");
    expect((await change("fld_1", "read")).items).toEqual([
      { kind: "folder", id: "fld_1", display: "~/A", access: "write" },
    ]);
    expect(calls).toEqual([["access", "fld_1", "read"]]);
    const mock = createMockLocalCapabilities({
      enabled: true,
      items: [{ kind: "folder", id: "fld_1", display: "~/A", access: "read" }],
    });
    expect((await mock.setAccess?.("fld_1", "write"))?.items[0]).toMatchObject({ access: "write" });
  });
});
