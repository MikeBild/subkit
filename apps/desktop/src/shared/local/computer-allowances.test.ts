import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DeviceSubBoundary } from "@shared/device/boundary.ts";
import {
  addApp,
  addKeepOut,
  appAccess,
  appDigest,
  COMPUTER_APPS_MAX,
  COMPUTER_KEEP_OUT_MAX,
  COMPUTER_OFF,
  type ComputerApp,
  type ComputerSnapshot,
  computerClosed,
  computerOffered,
  computerPermissions,
  frontmostVerdict,
  isActing,
  modeOf,
  parseComputerSnapshot,
  removeApp,
  type TargetInput,
  targetVerdict,
} from "./computer-allowances.ts";

const NUMBERS: ComputerApp = {
  bundle_id: "com.apple.iWork.Numbers",
  team_id: null,
  display: "Numbers",
};
const SAFARI: ComputerApp = { bundle_id: "com.apple.Safari", team_id: null, display: "Safari" };
const DEVICE = "device-1";

const ON: ComputerSnapshot = {
  enabled: true,
  personal_enabled: true,
  apps: [NUMBERS, SAFARI],
  keep_out: [{ bundle_id: "com.example.Diary", display: "Diary" }],
  permissions: { accessibility: true, screen: true },
  helper: { path: "/Applications/SubKit.app/Contents/Helpers/agent-desktop", state_root: "/tmp/s" },
};

function boundary(app: ComputerApp, digest = appDigest(DEVICE, app)): DeviceSubBoundary {
  return {
    device_id: DEVICE,
    capability: "computer",
    apps: [{ app_id: app.bundle_id, app_digest: digest }],
  };
}

function input(overrides: Partial<TargetInput> = {}): TargetInput {
  return {
    kind: "computer.press",
    mode: "personal",
    device_id: DEVICE,
    snapshot: ON,
    boundary: undefined,
    target: { bundle_id: NUMBERS.bundle_id, name: "Numbers" },
    ...overrides,
  };
}

describe("parseComputerSnapshot", () => {
  test("keeps a valid snapshot and falls back to off for anything else", () => {
    expect(parseComputerSnapshot(ON)).toEqual(ON);
    expect(parseComputerSnapshot({ ...ON, extra: 1 })).toEqual(COMPUTER_OFF);
    expect(
      parseComputerSnapshot({ ...ON, helper: { path: "agent-desktop", state_root: "/s" } }),
    ).toEqual(COMPUTER_OFF);
    expect(parseComputerSnapshot(null)).toEqual(COMPUTER_OFF);
  });

  test("rejects bundle ids that could become flags and team ids of the wrong shape", () => {
    expect(parseComputerSnapshot({ ...ON, apps: [{ ...NUMBERS, bundle_id: "-x" }] })).toEqual(
      COMPUTER_OFF,
    );
    expect(parseComputerSnapshot({ ...ON, apps: [{ ...NUMBERS, team_id: "abc" }] })).toEqual(
      COMPUTER_OFF,
    );
    expect(
      parseComputerSnapshot({ ...ON, apps: [{ ...NUMBERS, team_id: "2S9ZC5J7X9" }] }).apps[0]
        ?.team_id,
    ).toBe("2S9ZC5J7X9");
  });

  test("caps the lists", () => {
    const many = Array.from({ length: COMPUTER_APPS_MAX + 1 }, (_, index) => ({
      ...NUMBERS,
      bundle_id: `com.example.app${index}`,
    }));
    expect(parseComputerSnapshot({ ...ON, apps: many })).toEqual(COMPUTER_OFF);
    expect(parseComputerSnapshot({ ...ON, apps: many.slice(1) }).apps).toHaveLength(
      COMPUTER_APPS_MAX,
    );
  });

  test("a workflow needs only the helper, chat and tasks also the personal switch", () => {
    const workflow = { execution_id: "e1" };
    const personal = { execution_id: null };
    expect(computerClosed(ON, workflow)).toBe(false);
    expect(computerClosed(ON, personal)).toBe(false);
    const switchedOff = { ...ON, personal_enabled: false };
    expect(computerClosed(switchedOff, workflow)).toBe(false);
    expect(computerClosed(switchedOff, personal)).toBe(true);
    expect(computerClosed({ ...ON, enabled: false }, workflow)).toBe(true);
    expect(computerClosed({ ...ON, helper: null }, workflow)).toBe(true);
  });

  test("the device offers computer use once the helper is there and both permissions are granted", () => {
    expect(computerOffered(ON)).toBe(true);
    expect(computerOffered({ ...ON, personal_enabled: false })).toBe(true);
    expect(computerOffered({ ...ON, enabled: false })).toBe(false);
    expect(computerOffered({ ...ON, helper: null })).toBe(false);
    expect(computerOffered({ ...ON, permissions: { accessibility: false, screen: true } })).toBe(
      false,
    );
    expect(computerOffered({ ...ON, permissions: { accessibility: true, screen: false } })).toBe(
      false,
    );
  });

  test("is off by default", () => {
    expect(COMPUTER_OFF).toEqual({
      enabled: false,
      personal_enabled: false,
      apps: [],
      keep_out: [],
      permissions: { accessibility: false, screen: false },
      helper: null,
    });
  });
});

describe("computerPermissions", () => {
  test("takes the U4 permission port status, Screen Recording only after the restart", () => {
    expect(
      computerPermissions({ accessibility: true, screen: true, restartPending: false }),
    ).toEqual({
      accessibility: true,
      screen: true,
    });
    expect(
      computerPermissions({ accessibility: false, screen: true, restartPending: true }),
    ).toEqual({
      accessibility: false,
      screen: false,
    });
  });
});

describe("allowance changes", () => {
  const empty: ComputerSnapshot = { ...ON, apps: [], keep_out: [] };

  test("adds an app once, also when the case differs", () => {
    const added = addApp(empty, NUMBERS);
    expect(added).toEqual({ ok: true, snapshot: { ...empty, apps: [NUMBERS] } });
    if (!added.ok) throw new Error("expected ok");
    expect(addApp(added.snapshot, { ...NUMBERS, bundle_id: "COM.APPLE.IWORK.NUMBERS" })).toEqual({
      ok: false,
      code: "duplicate",
    });
  });

  test("never adds a blocked app, by bundle id or by name", () => {
    expect(addApp(empty, { bundle_id: "com.apple.Terminal", team_id: null, display: "x" })).toEqual(
      {
        ok: false,
        code: "blocked_app",
      },
    );
    expect(
      addApp(empty, { bundle_id: "com.example.tool", team_id: null, display: "1Password" }),
    ).toEqual({
      ok: false,
      code: "blocked_app",
    });
    expect(
      addApp(empty, { bundle_id: "dev.mikebild.subkit.desktop", team_id: null, display: "S" }),
    ).toEqual({
      ok: false,
      code: "blocked_app",
    });
  });

  test("view-only apps can be added, the action check limits them later", () => {
    expect(addApp(empty, SAFARI).ok).toBe(true);
  });

  test("refuses an app on the keep-out list", () => {
    const kept = { ...empty, keep_out: [{ bundle_id: "com.apple.iwork.numbers", display: "N" }] };
    expect(addApp(kept, NUMBERS)).toEqual({ ok: false, code: "keep_out" });
  });

  test("refuses the app after the limit, accepts the last free slot", () => {
    const apps = Array.from({ length: COMPUTER_APPS_MAX - 1 }, (_, index) => ({
      ...NUMBERS,
      bundle_id: `com.example.app${index}`,
    }));
    const almost = { ...empty, apps };
    const last = addApp(almost, NUMBERS);
    expect(last.ok).toBe(true);
    if (!last.ok) throw new Error("expected ok");
    expect(addApp(last.snapshot, SAFARI)).toEqual({ ok: false, code: "full" });
  });

  test("keep-out removes the app from the allowed list and refuses duplicates", () => {
    const added = addKeepOut(ON, { bundle_id: "COM.APPLE.IWORK.NUMBERS", display: "Numbers" });
    expect(added).toEqual({
      ok: true,
      snapshot: {
        ...ON,
        apps: [SAFARI],
        keep_out: [...ON.keep_out, { bundle_id: "COM.APPLE.IWORK.NUMBERS", display: "Numbers" }],
      },
    });
    expect(addKeepOut(ON, { bundle_id: "COM.EXAMPLE.DIARY", display: "D" })).toEqual({
      ok: false,
      code: "duplicate",
    });
  });

  test("keep-out list has a limit", () => {
    const keepOut = Array.from({ length: COMPUTER_KEEP_OUT_MAX - 1 }, (_, index) => ({
      bundle_id: `com.example.k${index}`,
      display: "k",
    }));
    const last = addKeepOut(
      { ...ON, keep_out: keepOut },
      { bundle_id: "com.example.last", display: "l" },
    );
    expect(last.ok).toBe(true);
    if (!last.ok) throw new Error("expected ok");
    expect(addKeepOut(last.snapshot, { bundle_id: "com.example.more", display: "m" })).toEqual({
      ok: false,
      code: "full",
    });
  });

  test("removes an app regardless of case", () => {
    expect(removeApp(ON, "COM.APPLE.SAFARI")).toEqual({ ...ON, apps: [NUMBERS] });
    expect(removeApp(ON, "com.example.none")).toEqual(ON);
  });
});

describe("appDigest", () => {
  test("hashes the P0 app material", () => {
    const expected = createHash("sha256")
      .update(JSON.stringify(["app", DEVICE, NUMBERS.bundle_id, null]), "utf8")
      .digest("hex");
    expect(appDigest(DEVICE, NUMBERS)).toBe(expected);
    expect(appDigest(DEVICE, { ...NUMBERS, team_id: "2S9ZC5J7X9" })).not.toBe(expected);
  });
});

describe("appAccess", () => {
  test("allows an allowed app, matched without case", () => {
    expect(appAccess(ON, { bundle_id: "COM.APPLE.IWORK.NUMBERS", name: "Numbers" })).toEqual({
      ok: true,
      app: NUMBERS,
    });
  });

  test("refuses blocked apps with blocked_app even when someone allowed them", () => {
    const tricked = {
      ...ON,
      apps: [...ON.apps, { bundle_id: "com.apple.Terminal", team_id: null, display: "T" }],
    };
    expect(appAccess(tricked, { bundle_id: "com.apple.Terminal", name: "Terminal" })).toEqual({
      ok: false,
      code: "blocked_app",
    });
  });

  test("refuses keep-out and unknown apps as outside the allowance", () => {
    const kept = {
      ...ON,
      apps: [...ON.apps, { bundle_id: "com.example.Diary", team_id: null, display: "D" }],
    };
    expect(appAccess(kept, { bundle_id: "COM.EXAMPLE.DIARY", name: "Diary" })).toEqual({
      ok: false,
      code: "outside_allowance",
    });
    expect(appAccess(ON, { bundle_id: "com.example.other", name: "Other" })).toEqual({
      ok: false,
      code: "outside_allowance",
    });
  });

  test("an app without bundle id never matches the list", () => {
    const odd = { ...ON, apps: [{ bundle_id: "x", team_id: null, display: "X" }] };
    expect(appAccess(odd, { bundle_id: null, name: "Calculator" })).toEqual({
      ok: false,
      code: "outside_allowance",
    });
    expect(appAccess(odd, { bundle_id: null, name: null })).toEqual({
      ok: false,
      code: "blocked_app",
    });
  });
});

describe("modeOf", () => {
  test("a run is a workflow, a task or chat is the personal mode", () => {
    expect(modeOf({ execution_id: "e" })).toBe("workflow");
    expect(modeOf({ execution_id: null })).toBe("personal");
  });
});

describe("targetVerdict", () => {
  test("allows an allowed app in personal mode", () => {
    expect(targetVerdict(input())).toEqual({ ok: true, app: NUMBERS });
  });

  test("refuses everything while computer use is off", () => {
    expect(targetVerdict(input({ snapshot: { ...ON, enabled: false } }))).toEqual({
      ok: false,
      code: "outside_allowance",
    });
  });

  test("refuses without Accessibility and screenshots without Screen Recording", () => {
    const noAx = { ...ON, permissions: { accessibility: false, screen: true } };
    expect(targetVerdict(input({ snapshot: noAx }))).toEqual({
      ok: false,
      code: "permission_missing",
    });
    const noScreen = { ...ON, permissions: { accessibility: true, screen: false } };
    expect(targetVerdict(input({ snapshot: noScreen, kind: "computer.screenshot" }))).toEqual({
      ok: false,
      code: "permission_missing",
    });
    expect(targetVerdict(input({ snapshot: noScreen, kind: "computer.snapshot" }))).toEqual({
      ok: true,
      app: NUMBERS,
    });
  });

  test("view-only apps can be read but not operated", () => {
    const safari = { bundle_id: SAFARI.bundle_id, name: "Safari" };
    expect(targetVerdict(input({ target: safari, kind: "computer.snapshot" }))).toEqual({
      ok: true,
      app: SAFARI,
    });
    expect(targetVerdict(input({ target: safari, kind: "computer.type" }))).toEqual({
      ok: false,
      code: "blocked_app",
    });
  });

  test("blocked and keep-out targets are refused", () => {
    expect(
      targetVerdict(input({ target: { bundle_id: "com.apple.systempreferences", name: "x" } })),
    ).toEqual({
      ok: false,
      code: "blocked_app",
    });
    expect(
      targetVerdict(input({ target: { bundle_id: "com.example.Diary", name: "Diary" } })),
    ).toEqual({
      ok: false,
      code: "outside_allowance",
    });
  });

  test("a workflow needs the app in its approved boundary with the same digest", () => {
    expect(targetVerdict(input({ mode: "workflow", boundary: boundary(NUMBERS) }))).toEqual({
      ok: true,
      app: NUMBERS,
    });
    const outside = { ok: false, code: "outside_boundary" } as const;
    expect(targetVerdict(input({ mode: "workflow" }))).toEqual(outside);
    expect(targetVerdict(input({ mode: "workflow", boundary: boundary(SAFARI) }))).toEqual(outside);
    expect(
      targetVerdict(input({ mode: "workflow", boundary: boundary(NUMBERS, "0".repeat(64)) })),
    ).toEqual(outside);
    expect(
      targetVerdict(
        input({ mode: "workflow", boundary: { ...boundary(NUMBERS), device_id: "other" } }),
      ),
    ).toEqual(outside);
    expect(
      targetVerdict(
        input({ mode: "workflow", boundary: { ...boundary(NUMBERS), capability: "files" } }),
      ),
    ).toEqual(outside);
    const { apps: _apps, ...noApps } = boundary(NUMBERS);
    expect(targetVerdict(input({ mode: "workflow", boundary: noApps }))).toEqual(outside);
  });

  test("personal mode ignores a boundary", () => {
    expect(targetVerdict(input({ boundary: boundary(SAFARI) }))).toEqual({
      ok: true,
      app: NUMBERS,
    });
  });
});

describe("frontmostVerdict", () => {
  test("the frontmost app must be allowed", () => {
    expect(frontmostVerdict(ON, { bundle_id: NUMBERS.bundle_id, name: "Numbers" })).toEqual({
      ok: true,
      app: NUMBERS,
    });
    expect(frontmostVerdict(ON, { bundle_id: "com.apple.Terminal", name: "Terminal" })).toEqual({
      ok: false,
      code: "blocked_app",
    });
    expect(frontmostVerdict(ON, { bundle_id: "com.example.x", name: "X" })).toEqual({
      ok: false,
      code: "outside_allowance",
    });
  });

  test("no frontmost window refuses", () => {
    expect(frontmostVerdict(ON, null)).toEqual({ ok: false, code: "outside_allowance" });
  });
});

describe("isActing", () => {
  test("observing kinds do not act, everything else does", () => {
    for (const kind of [
      "computer.apps",
      "computer.snapshot",
      "computer.find",
      "computer.screenshot",
    ] as const) {
      expect(isActing(kind)).toBe(false);
    }
    for (const kind of [
      "computer.press",
      "computer.type",
      "computer.key",
      "computer.scroll",
      "computer.focus",
      "computer.select",
      "computer.set_value",
      "computer.open",
    ] as const) {
      expect(isActing(kind)).toBe(true);
    }
  });
});

describe("allowance edge cases", () => {
  test("rejects bundle ids with a bad tail and team ids of eleven characters", () => {
    expect(parseComputerSnapshot({ ...ON, apps: [{ ...NUMBERS, bundle_id: "com.x!" }] })).toEqual(
      COMPUTER_OFF,
    );
    expect(
      parseComputerSnapshot({ ...ON, apps: [{ ...NUMBERS, team_id: "X2S9ZC5J7X9" }] }),
    ).toEqual(COMPUTER_OFF);
    expect(
      parseComputerSnapshot({ ...ON, apps: [{ ...NUMBERS, team_id: "2S9ZC5J7X9X" }] }),
    ).toEqual(COMPUTER_OFF);
    expect(
      parseComputerSnapshot({ ...ON, helper: { path: "/a/agent-desktop", state_root: "state" } }),
    ).toEqual(COMPUTER_OFF);
  });

  const twoKept: ComputerSnapshot = {
    ...ON,
    keep_out: [
      { bundle_id: "com.example.first", display: "F" },
      { bundle_id: "com.example.Diary", display: "D" },
    ],
  };

  test("any keep-out entry counts, not only when all match", () => {
    expect(addKeepOut(twoKept, { bundle_id: "com.example.diary", display: "D" })).toEqual({
      ok: false,
      code: "duplicate",
    });
    const kept = {
      ...twoKept,
      apps: [...ON.apps, { bundle_id: "com.example.Diary", team_id: null, display: "D" }],
    };
    expect(appAccess(kept, { bundle_id: "com.example.Diary", name: "Diary" })).toEqual({
      ok: false,
      code: "outside_allowance",
    });
  });

  test("the boundary entry must name the same app, not only carry its digest", () => {
    const misnamed: DeviceSubBoundary = {
      device_id: DEVICE,
      capability: "computer",
      apps: [{ app_id: "com.example.other", app_digest: appDigest(DEVICE, NUMBERS) }],
    };
    expect(targetVerdict(input({ mode: "workflow", boundary: misnamed }))).toEqual({
      ok: false,
      code: "outside_boundary",
    });
  });

  test("a refused app in a workflow stays refused before the boundary is read", () => {
    expect(
      targetVerdict(
        input({
          mode: "workflow",
          boundary: boundary(NUMBERS),
          target: { bundle_id: "com.example.x", name: "X" },
        }),
      ),
    ).toEqual({ ok: false, code: "outside_allowance" });
  });
});
