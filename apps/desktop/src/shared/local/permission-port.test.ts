import { describe, expect, test } from "bun:test";
import type { PermissionProbe } from "./permission-model.ts";
import {
  MacPermissions,
  type PermissionLogValue,
  type PermissionSystem,
} from "./permission-port.ts";

const SCREEN_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const AX_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

function fakeSystem(patch: Partial<PermissionSystem> = {}) {
  const calls = {
    prompts: [] as boolean[],
    opened: [] as string[],
    relaunched: 0,
    screenRequests: 0,
    helperProbes: 0,
    order: [] as string[],
    logs: [] as { event: string; fields: Record<string, PermissionLogValue> }[],
  };
  let accessibility = false;
  let screen = "denied";
  let helper: PermissionProbe | null = null;
  const system: PermissionSystem = {
    platform: "darwin",
    processPath: "/Applications/SubKit.app/Contents/MacOS/SubKit",
    isTrustedAccessibilityClient: (prompt) => {
      calls.prompts.push(prompt);
      if (prompt) calls.order.push("request:accessibility");
      return accessibility;
    },
    getMediaAccessStatus: () => screen,
    requestScreenCapture: async () => {
      calls.screenRequests++;
      calls.order.push("request:screen");
    },
    probeHelper: async () => {
      calls.helperProbes++;
      return helper;
    },
    openExternal: async (url) => {
      calls.opened.push(url);
      calls.order.push(`open:${url}`);
    },
    relaunch: () => {
      calls.relaunched++;
    },
    log: (event, fields) => {
      calls.logs.push({ event, fields });
    },
    ...patch,
  };
  return {
    system,
    calls,
    grant(next: { accessibility?: boolean; screen?: string; helper?: PermissionProbe | null }) {
      accessibility = next.accessibility ?? accessibility;
      screen = next.screen ?? screen;
      if (next.helper !== undefined) helper = next.helper;
    },
  };
}

describe("MacPermissions", () => {
  test("checking never prompts", async () => {
    const fake = fakeSystem();
    const permissions = new MacPermissions(fake.system);
    permissions.check();
    await permissions.refresh();
    expect(fake.calls.prompts).toEqual([false, false, false]);
    expect(fake.calls.screenRequests).toBe(0);
  });

  test("starts from the status at launch", () => {
    const fake = fakeSystem();
    fake.grant({ accessibility: true, screen: "granted" });
    expect(new MacPermissions(fake.system).view()).toEqual({
      supported: true,
      permissions: { accessibility: true, screen: true, restartPending: false },
      lost: [],
    });
  });

  test("a Screen Recording grant after launch asks for a restart", () => {
    const fake = fakeSystem();
    const permissions = new MacPermissions(fake.system);
    fake.grant({ accessibility: true, screen: "granted" });
    expect(permissions.check().permissions).toEqual({
      accessibility: true,
      screen: true,
      restartPending: true,
    });
  });

  test("a permission that goes missing stays flagged until it is granted again", () => {
    const fake = fakeSystem();
    fake.grant({ accessibility: true, screen: "granted" });
    const permissions = new MacPermissions(fake.system);
    fake.grant({ accessibility: false });
    expect(permissions.check().lost).toEqual(["accessibility"]);
    expect(permissions.check().lost).toEqual(["accessibility"]);
    fake.grant({ accessibility: true });
    expect(permissions.check().lost).toEqual([]);
  });

  test("unknown screen statuses count as missing", () => {
    const fake = fakeSystem();
    fake.grant({ screen: "something-new" });
    expect(new MacPermissions(fake.system).view().permissions.screen).toBe(false);
  });

  test("opening Screen Recording requests capture first, then opens the pane", async () => {
    const fake = fakeSystem();
    const permissions = new MacPermissions(fake.system);
    expect(await permissions.open("screen")).toBe(true);
    expect(fake.calls.order).toEqual(["request:screen", `open:${SCREEN_PANE}`]);
    expect(fake.calls.logs).toEqual([
      {
        event: "permissions.requested",
        fields: {
          permission: "screen",
          process: "/Applications/SubKit.app/Contents/MacOS/SubKit",
          before: "denied",
          result: "requested",
          after: "denied",
        },
      },
    ]);
  });

  test("opening Accessibility asks for trust with the prompt, then opens the pane", async () => {
    const fake = fakeSystem();
    const permissions = new MacPermissions(fake.system);
    expect(await permissions.open("accessibility")).toBe(true);
    expect(fake.calls.order).toEqual(["request:accessibility", `open:${AX_PANE}`]);
    expect(fake.calls.logs[0]?.fields).toMatchObject({
      permission: "accessibility",
      result: "false",
    });
  });

  test("a granted permission opens the pane without a request", async () => {
    const fake = fakeSystem();
    fake.grant({ accessibility: true, screen: "granted" });
    const permissions = new MacPermissions(fake.system);
    await permissions.open("screen");
    await permissions.open("accessibility");
    expect(fake.calls.order).toEqual([`open:${SCREEN_PANE}`, `open:${AX_PANE}`]);
    expect(fake.calls.logs).toEqual([]);
  });

  test("a failed screen request still opens the pane and logs the failure", async () => {
    const fake = fakeSystem({ requestScreenCapture: async () => Promise.reject(new Error("tcc")) });
    const permissions = new MacPermissions(fake.system);
    expect(await permissions.open("screen")).toBe(true);
    expect(fake.calls.opened).toEqual([SCREEN_PANE]);
    expect(fake.calls.logs[0]?.fields.result).toBe("failed: tcc");
  });

  test("a hanging screen request gives up after the limit and still opens the pane", async () => {
    const fake = fakeSystem({ requestScreenCapture: () => new Promise(() => {}) });
    const permissions = new MacPermissions(fake.system, 5);
    expect(await permissions.open("screen")).toBe(true);
    expect(fake.calls.logs[0]?.fields.result).toBe("timeout");
  });

  test("the first use requests every missing permission once per launch", async () => {
    const fake = fakeSystem();
    fake.grant({ accessibility: true });
    const permissions = new MacPermissions(fake.system);
    expect(await permissions.requestMissingOnce()).toEqual(["screen"]);
    expect(await permissions.requestMissingOnce()).toEqual([]);
    expect(fake.calls.screenRequests).toBe(1);
    expect(fake.calls.prompts.filter(Boolean)).toEqual([]);
  });

  test("check again detects a grant the running process cannot see yet and asks for a restart", async () => {
    const fake = fakeSystem();
    fake.grant({ accessibility: true });
    const permissions = new MacPermissions(fake.system);
    fake.grant({ helper: { accessibility: true, screen: "granted" } });
    const view = await permissions.refresh();
    expect(view.permissions).toEqual({ accessibility: true, screen: true, restartPending: true });
    expect(permissions.check().permissions.screen).toBe(true);
    expect(fake.calls.logs.at(-1)).toEqual({
      event: "permissions.checked",
      fields: {
        process: "/Applications/SubKit.app/Contents/MacOS/SubKit",
        accessibility: true,
        screen: true,
        helper_screen: "granted",
        restart_pending: true,
      },
    });
  });

  test("a helper that cannot answer falls back to the own status", async () => {
    const fake = fakeSystem({ probeHelper: async () => Promise.reject(new Error("gone")) });
    const permissions = new MacPermissions(fake.system);
    expect((await permissions.refresh()).permissions.screen).toBe(false);
  });

  test("concurrent checks share one helper probe", async () => {
    const fake = fakeSystem();
    const permissions = new MacPermissions(fake.system);
    await Promise.all([permissions.refresh(), permissions.refresh(), permissions.refresh()]);
    expect(fake.calls.helperProbes).toBe(1);
  });

  test("restarts on request", () => {
    const fake = fakeSystem();
    const permissions = new MacPermissions(fake.system);
    expect(permissions.relaunch()).toBe(true);
    expect(fake.calls.relaunched).toBe(1);
  });

  test("a failed deep link reports false", async () => {
    const fake = fakeSystem({ openExternal: async () => Promise.reject(new Error("no")) });
    expect(await new MacPermissions(fake.system).open("accessibility")).toBe(false);
  });

  test("other systems are not supported and nothing is touched", async () => {
    const fake = fakeSystem({ platform: "win32" });
    const permissions = new MacPermissions(fake.system);
    expect(permissions.check()).toEqual({
      supported: false,
      permissions: { accessibility: false, screen: false, restartPending: false },
      lost: [],
    });
    await permissions.refresh();
    expect(await permissions.open("accessibility")).toBe(false);
    expect(await permissions.requestMissingOnce()).toEqual([]);
    expect(permissions.relaunch()).toBe(false);
    expect(fake.calls).toMatchObject({
      prompts: [],
      opened: [],
      relaunched: 0,
      screenRequests: 0,
      helperProbes: 0,
      logs: [],
    });
  });
});
