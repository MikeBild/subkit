import { describe, expect, test } from "bun:test";
import { MacPermissions, type PermissionSystem } from "./permission-port.ts";

function fakeSystem(patch: Partial<PermissionSystem> = {}) {
  const calls = { prompts: [] as boolean[], opened: [] as string[], relaunched: 0 };
  let accessibility = false;
  let screen = "denied";
  const system: PermissionSystem = {
    platform: "darwin",
    isTrustedAccessibilityClient: (prompt) => {
      calls.prompts.push(prompt);
      return accessibility;
    },
    getMediaAccessStatus: () => screen,
    openExternal: async (url) => {
      calls.opened.push(url);
    },
    relaunch: () => {
      calls.relaunched++;
    },
    ...patch,
  };
  return {
    system,
    calls,
    grant(next: { accessibility?: boolean; screen?: string }) {
      accessibility = next.accessibility ?? accessibility;
      screen = next.screen ?? screen;
    },
  };
}

describe("MacPermissions", () => {
  test("only checks, never prompts", () => {
    const fake = fakeSystem();
    const permissions = new MacPermissions(fake.system);
    permissions.check();
    expect(fake.calls.prompts).toEqual([false, false]);
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

  test("opens only the fixed privacy pane and restarts on request", async () => {
    const fake = fakeSystem();
    const permissions = new MacPermissions(fake.system);
    expect(await permissions.open("screen")).toBe(true);
    expect(fake.calls.opened).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ]);
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
    expect(await permissions.open("accessibility")).toBe(false);
    expect(permissions.relaunch()).toBe(false);
    expect(fake.calls).toEqual({ prompts: [], opened: [], relaunched: 0 });
  });
});
