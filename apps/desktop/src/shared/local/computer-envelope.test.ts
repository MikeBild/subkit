import { describe, expect, test } from "bun:test";
import {
  errorVerdict,
  frontmostWindow,
  HELPER_CONTRACT_VERSION,
  inventoryOf,
  parseEnvelope,
  screenshotData,
  snapshotData,
  touchedSecureField,
} from "./computer-envelope.ts";

const OK = { version: "2.6", ok: true, command: "click", data: { action: "click" } };
const ERROR = {
  version: "2.6",
  ok: false,
  command: "click",
  error: { code: "STALE_REF", disposition: { delivery: "not_delivered", retry: "safe" } },
};

describe("parseEnvelope", () => {
  test("reads the last line as one envelope", () => {
    expect(parseEnvelope(`noise\n${JSON.stringify(OK)}\n`)).toEqual({ ok: true, envelope: OK });
    expect(parseEnvelope(JSON.stringify(ERROR))).toEqual({ ok: true, envelope: ERROR });
  });

  test("keeps unknown keys", () => {
    const extra = { ...OK, extra: 1 };
    expect(parseEnvelope(JSON.stringify(extra))).toEqual({ ok: true, envelope: extra });
  });

  test("refuses text, wrong shapes and other contract versions", () => {
    expect(parseEnvelope("agent-desktop 1.3.1")).toEqual({ ok: false, reason: "not_json" });
    expect(parseEnvelope("")).toEqual({ ok: false, reason: "not_json" });
    expect(parseEnvelope(JSON.stringify({ ok: true }))).toEqual({ ok: false, reason: "shape" });
    expect(parseEnvelope(JSON.stringify({ ...OK, version: "2.5" }))).toEqual({
      ok: false,
      reason: "version",
    });
    expect(HELPER_CONTRACT_VERSION).toBe("2.6");
  });

  test("a success needs data and a failure needs an error", () => {
    const { data: _data, ...noData } = OK;
    expect(parseEnvelope(JSON.stringify(noData))).toEqual({ ok: false, reason: "shape" });
    const { error: _error, ...noError } = ERROR;
    expect(parseEnvelope(JSON.stringify(noError))).toEqual({ ok: false, reason: "shape" });
    expect(parseEnvelope(JSON.stringify({ ...OK, data: null })).ok).toBe(true);
  });
});

describe("errorVerdict", () => {
  const notDelivered = { delivery: "not_delivered", retry: "safe" };

  test("anything that may have been delivered is never a refusal", () => {
    for (const delivery of ["delivery_uncertain", "delivered_unverified", "unknown"]) {
      expect(errorVerdict({ code: "STALE_REF", disposition: { delivery } }, "click")).toEqual({
        kind: "failed",
        code: "delivery_uncertain",
      });
    }
    expect(errorVerdict({ code: "PERM_DENIED" }, "click")).toEqual({
      kind: "failed",
      code: "delivery_uncertain",
    });
  });

  test("maps undelivered errors onto the device refusals", () => {
    expect(errorVerdict({ code: "PERM_DENIED", disposition: notDelivered }, "snapshot")).toEqual({
      kind: "refused",
      code: "permission_missing",
    });
    for (const code of [
      "STALE_REF",
      "SNAPSHOT_NOT_FOUND",
      "AMBIGUOUS_TARGET",
      "WINDOW_NOT_FOUND",
      "ELEMENT_NOT_FOUND",
      "APP_NOT_FOUND",
    ]) {
      expect(errorVerdict({ code, disposition: notDelivered }, "click")).toEqual({
        kind: "refused",
        code: "stale",
      });
    }
    expect(errorVerdict({ code: "POLICY_DENIED", disposition: notDelivered }, "press")).toEqual({
      kind: "refused",
      code: "blocked_shortcut",
    });
  });

  test("other undelivered errors fail with the helper code", () => {
    expect(errorVerdict({ code: "POLICY_DENIED", disposition: notDelivered }, "click")).toEqual({
      kind: "failed",
      code: "helper_policy_denied",
    });
    expect(errorVerdict({ code: "TIMEOUT", disposition: notDelivered }, "click")).toEqual({
      kind: "failed",
      code: "helper_timeout",
    });
  });
});

describe("touchedSecureField", () => {
  test("detects the secure field verification reason only", () => {
    expect(touchedSecureField({ details: { verification_reason: "secure_field" } })).toBe(true);
    expect(touchedSecureField({ details: { verification_reason: "insufficient_evidence" } })).toBe(
      false,
    );
    expect(touchedSecureField({ details: {} })).toBe(false);
    expect(touchedSecureField({})).toBe(false);
    expect(touchedSecureField(null)).toBe(false);
  });
});

const WINDOWS = [
  {
    accessible: true,
    app_name: "Numbers",
    bounds: { height: 600, width: 800, x: 10, y: 20 },
    id: "w-1",
    is_focused: true,
    pid: 10,
    title: "Budget",
  },
  { app_name: "Mystery", id: "w-2", pid: 99 },
];
const APPS = { apps: [{ bundle_id: "com.apple.iWork.Numbers", name: "Numbers", pid: 10 }] };

describe("inventoryOf", () => {
  test("joins windows with their app by pid", () => {
    expect(inventoryOf(WINDOWS, APPS)).toEqual([
      {
        id: "w-1",
        app: { bundle_id: "com.apple.iWork.Numbers", name: "Numbers" },
        title: "Budget",
        bounds: { height: 600, width: 800, x: 10, y: 20 },
        focused: true,
      },
      {
        id: "w-2",
        app: { bundle_id: null, name: "Mystery" },
        title: "",
        bounds: null,
        focused: false,
      },
    ]);
  });

  test("an app without bundle id keeps its name", () => {
    const apps = { apps: [{ bundle_id: null, name: "Tool", pid: 99 }] };
    expect(inventoryOf([WINDOWS[1]], apps)?.[0]?.app).toEqual({ bundle_id: null, name: "Tool" });
  });

  test("refuses shapes it cannot trust", () => {
    expect(inventoryOf({ windows: [] }, APPS)).toBeNull();
    expect(inventoryOf(WINDOWS, [])).toBeNull();
    expect(inventoryOf([{ id: "", app_name: "x", pid: 1 }], APPS)).toBeNull();
  });
});

describe("frontmostWindow", () => {
  test("returns the focused window or none", () => {
    const listed = inventoryOf(WINDOWS, APPS) ?? [];
    expect(frontmostWindow(listed)?.id).toBe("w-1");
    expect(frontmostWindow(listed.slice(1))).toBeNull();
  });
});

describe("snapshotData and screenshotData", () => {
  test("read the fields the driver needs", () => {
    expect(
      snapshotData({ snapshot_id: "s1", complete: true, tree: { role: "window" }, app: "x" }),
    ).toEqual({
      snapshot_id: "s1",
      complete: true,
      tree: { role: "window" },
    });
    expect(snapshotData({ snapshot_id: "s1", tree: {} })).toBeNull();
    const shot = { format: "png" as const, data: "AA==", width: 2, height: 3, scale_factor: 2 };
    expect(screenshotData(shot)).toEqual(shot);
    expect(screenshotData({ ...shot, format: "jpeg" })).toBeNull();
    expect(screenshotData({ ...shot, scale_factor: 0 })).toBeNull();
    expect(screenshotData({ ...shot, path: "/tmp/x.png", data: "" })).toBeNull();
  });
});

describe("envelope shapes", () => {
  test("an error needs a code and a disposition needs a delivery", () => {
    const base = { version: "2.6", ok: false, command: "click" };
    expect(parseEnvelope(JSON.stringify({ ...base, error: { message: "x" } }))).toEqual({
      ok: false,
      reason: "shape",
    });
    expect(
      parseEnvelope(
        JSON.stringify({ ...base, error: { code: "X", disposition: { retry: "safe" } } }),
      ),
    ).toEqual({
      ok: false,
      reason: "shape",
    });
  });

  test("a press error other than the policy refusal keeps its own code", () => {
    expect(
      errorVerdict({ code: "TIMEOUT", disposition: { delivery: "not_delivered" } }, "press"),
    ).toEqual({
      kind: "failed",
      code: "helper_timeout",
    });
  });

  test("apps need a pid and a list", () => {
    expect(inventoryOf(WINDOWS, { apps: [{ bundle_id: "x", name: "x" }] })).toBeNull();
    expect(inventoryOf(WINDOWS, { apps: "x" })).toBeNull();
    expect(inventoryOf(WINDOWS, {})).toBeNull();
  });
});
