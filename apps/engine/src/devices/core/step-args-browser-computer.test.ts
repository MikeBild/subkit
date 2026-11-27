import { describe, expect, test } from "bun:test";
import type { DeviceSubBoundary } from "@shared/device/boundary.ts";
import { parseCommandArgs } from "./command-args.ts";
import {
  approvedBoundary,
  argsWithRef,
  argsWithWindow,
  LOCAL_STEP_KINDS,
  localStepArgs,
  type StepArgsInput,
  windowFor,
} from "./step-args.ts";

const DEVICE = "6f1c2a7e-1b2c-4d3e-8f90-0a1b2c3d4e5f";
const D = (c: string) => c.repeat(64);
const PARTITION = "a1b2c3d4-0000-4000-8000-000000000001";

const files: DeviceSubBoundary = {
  device_id: DEVICE,
  capability: "files",
  folders: [
    { folder_id: "docs", access: "write", root_digest: D("a") },
    { folder_id: "inbox", access: "read", root_digest: D("b") },
  ],
};
const browser: DeviceSubBoundary = {
  device_id: DEVICE,
  capability: "browser",
  sites: [{ origin: "https://shop.example", private: false, site_digest: D("c") }],
  folders: [
    { folder_id: "docs", access: "write", root_digest: D("a") },
    { folder_id: "inbox", access: "read", root_digest: D("b") },
  ],
};
const computer: DeviceSubBoundary = {
  device_id: DEVICE,
  capability: "computer",
  apps: [{ app_id: "com.apple.iWork.Numbers", app_digest: D("d") }],
};

function plan(input: Partial<StepArgsInput> & Pick<StepArgsInput, "kind" | "body">) {
  const capability = input.kind.split(".")[0];
  const boundary =
    "boundary" in input
      ? (input.boundary ?? null)
      : capability === "files"
        ? files
        : capability === "browser"
          ? browser
          : computer;
  return localStepArgs({
    method: input.method ?? "POST",
    partition: PARTITION,
    ...input,
    boundary,
  });
}

function args(input: Parameters<typeof plan>[0]) {
  const result = plan(input);
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
  return result.plan;
}

describe("browser bodies", () => {
  test("open checks the origin against the approved sites", () => {
    expect(args({ kind: "browser.open", body: { url: "https://shop.example/cart?x=1" } })).toEqual({
      kind: "browser.open",
      args: { url: "https://shop.example/cart?x=1", partition: PARTITION, boundary: browser },
      element: null,
      app_id: null,
    });
    for (const url of [
      "https://evil.example/",
      "http://shop.example/",
      "ftp://shop.example/",
      "nope",
    ])
      expect(plan({ kind: "browser.open", body: { url } })).toEqual({
        ok: false,
        code: "outside_boundary",
        detail: "This website is not part of this workflow's approval.",
      });
  });

  test("a browser step without approved sites is refused", () => {
    for (const sites of [undefined, []])
      expect(
        plan({
          kind: "browser.snapshot",
          method: "GET",
          body: {},
          boundary: { ...browser, sites },
        }),
      ).toEqual({
        ok: false,
        code: "outside_boundary",
        detail: "This workflow's approval names no website for this device.",
      });
  });

  test("ref actions name an element; the ref is filled in after a fresh snapshot", () => {
    const click = args({
      kind: "browser.press",
      body: { action: "click", element: { role: "button", name: "Buy", nth: 1 } },
    });
    expect(click).toEqual({
      kind: "browser.press",
      args: { action: "click", partition: PARTITION, boundary: browser },
      element: { role: "button", name: "Buy", nth: 1 },
      app_id: null,
    });
    const final = argsWithRef(click, { ref: "e7" });
    expect(final).toEqual({ action: "click", partition: PARTITION, boundary: browser, ref: "e7" });
    expect(parseCommandArgs("browser.press", final).ok).toBe(true);
    expect(parseCommandArgs("browser.press", click.args).ok).toBe(false);

    const fill = args({
      kind: "browser.fill",
      body: { mode: "type", element: { role: "textbox", name: "Search" }, text: "socks" },
    });
    expect(fill.args).toEqual({
      mode: "type",
      text: "socks",
      partition: PARTITION,
      boundary: browser,
    });
    const select = args({
      kind: "browser.fill",
      body: { mode: "select", element: { role: "combobox", name: "Size" }, values: ["M"] },
    });
    expect(parseCommandArgs("browser.fill", argsWithRef(select, { ref: "e2" })).ok).toBe(true);
    const extract = args({
      kind: "browser.extract",
      method: "GET",
      body: { element: { role: "table", name: "Orders" } },
    });
    expect(extract.element).toEqual({ role: "table", name: "Orders" });
    expect(args({ kind: "browser.extract", method: "GET", body: {} }).element).toBeNull();
  });

  test("key, scroll, wait and screenshot need no element; defaults are filled", () => {
    expect(args({ kind: "browser.press", body: { action: "key", key: "Enter" } }).args).toEqual({
      action: "key",
      key: "Enter",
      partition: PARTITION,
      boundary: browser,
    });
    expect(
      args({ kind: "browser.press", body: { action: "scroll", direction: "down" } }).args,
    ).toEqual({
      action: "scroll",
      direction: "down",
      pixels: 600,
      partition: PARTITION,
      boundary: browser,
    });
    expect(
      args({ kind: "browser.press", body: { action: "scroll", direction: "up", pixels: 50 } }).args
        .pixels,
    ).toBe(50);
    expect(args({ kind: "browser.wait", method: "GET", body: { for: "load" } }).args).toEqual({
      for: "load",
      state: "load",
      partition: PARTITION,
      boundary: browser,
    });
    expect(
      args({ kind: "browser.wait", method: "GET", body: { for: "load", state: "networkidle" } })
        .args.state,
    ).toBe("networkidle");
    expect(
      args({ kind: "browser.wait", method: "GET", body: { for: "ms", ms: 500 } }).args,
    ).toEqual({ for: "ms", ms: 500, partition: PARTITION, boundary: browser });
    const shot = args({ kind: "browser.screenshot", method: "GET", body: {} });
    expect(parseCommandArgs("browser.screenshot", shot.args).ok).toBe(true);
  });

  test("a download lands only in an approved folder with write access", () => {
    const body = { element: { role: "link", name: "PDF" }, folder_id: "docs", name: "a.pdf" };
    const download = args({ kind: "browser.download", body });
    expect(download.args).toEqual({
      folder_id: "docs",
      name: "a.pdf",
      partition: PARTITION,
      boundary: browser,
    });
    expect(parseCommandArgs("browser.download", argsWithRef(download, { ref: "e3" })).ok).toBe(
      true,
    );
    expect(plan({ kind: "browser.download", body: { ...body, folder_id: "inbox" } })).toEqual({
      ok: false,
      code: "outside_boundary",
      detail: "The approval lets this workflow only read the folder inbox.",
    });
  });
});

describe("computer bodies", () => {
  test("apps lists windows with the boundary only", () => {
    const apps = args({ kind: "computer.apps", method: "GET", body: {} });
    expect(apps).toEqual({
      kind: "computer.apps",
      args: { boundary: computer },
      element: null,
      app_id: null,
    });
    expect(parseCommandArgs("computer.apps", apps.args).ok).toBe(true);
  });

  test("window kinds name the app; the window comes from computer.apps", () => {
    const shot = args({
      kind: "computer.screenshot",
      method: "GET",
      body: { app_id: "com.apple.iWork.Numbers" },
    });
    expect(shot).toEqual({
      kind: "computer.screenshot",
      args: { boundary: computer },
      element: null,
      app_id: "com.apple.iWork.Numbers",
    });
    expect(parseCommandArgs("computer.screenshot", argsWithWindow(shot, "w-1")).ok).toBe(true);
    const key = args({
      kind: "computer.key",
      body: { app_id: "com.apple.iWork.Numbers", keys: "cmd+s" },
    });
    expect(key.args).toEqual({ keys: "cmd+s", boundary: computer });
    expect(parseCommandArgs("computer.key", argsWithWindow(key, "w-1")).ok).toBe(true);
  });

  test("ref actions carry window, ref and the snapshot's state hash", () => {
    const type = args({
      kind: "computer.type",
      body: {
        app_id: "com.apple.iWork.Numbers",
        element: { role: "cell", name: "A1" },
        text: "42",
      },
    });
    expect(type.args).toEqual({ text: "42", boundary: computer });
    const final = argsWithRef(type, { ref: "@s1:e4", window_id: "w-1", state_hash: D("f") });
    expect(final).toEqual({
      text: "42",
      boundary: computer,
      window_id: "w-1",
      ref: "@s1:e4",
      state_hash: D("f"),
    });
    expect(parseCommandArgs("computer.type", final).ok).toBe(true);
    const scroll = args({
      kind: "computer.scroll",
      body: {
        app_id: "com.apple.iWork.Numbers",
        element: { role: "table", name: "T" },
        direction: "down",
        amount: 3,
      },
    });
    expect(
      parseCommandArgs("computer.scroll", argsWithRef(scroll, { ref: "@s1:e1", window_id: "w" }))
        .ok,
    ).toBe(true);
  });

  test("an app filled in at run time must be approved", () => {
    expect(
      plan({ kind: "computer.snapshot", method: "GET", body: { app_id: "com.evil" } }),
    ).toEqual({
      ok: false,
      code: "outside_boundary",
      detail: "This app is not part of this workflow's approval.",
    });
    expect(
      plan({
        kind: "computer.snapshot",
        method: "GET",
        body: { app_id: "com.apple.iWork.Numbers" },
        boundary: { ...computer, apps: undefined },
      }),
    ).toMatchObject({ ok: false, code: "outside_boundary" });
  });

  test("every runnable kind has a body and an argument schema", () => {
    expect(LOCAL_STEP_KINDS).toHaveLength(27);
    for (const kind of LOCAL_STEP_KINDS)
      expect(parseCommandArgs(kind, { nonsense: true }).ok).toBe(false);
  });
});

describe("window for an app", () => {
  const output = {
    windows: [
      { window_id: "w-1", bundle_id: "com.other", focused: true },
      { window_id: "w-2", bundle_id: "com.apple.iWork.Numbers", focused: false },
      { window_id: "w-3", bundle_id: "com.apple.iWork.Numbers", focused: true },
      { window_id: 4, bundle_id: "com.apple.iWork.Numbers" },
      null,
      "noise",
    ],
  };

  test("prefers the focused window of the app, else its first", () => {
    expect(windowFor(output, "com.apple.iWork.Numbers")).toBe("w-3");
    expect(
      windowFor(
        { windows: [output.windows[1], { ...(output.windows[2] as object), focused: "yes" }] },
        "com.apple.iWork.Numbers",
      ),
    ).toBe("w-2");
    expect(windowFor(output, "com.absent")).toBeNull();
    expect(windowFor({ windows: "x" }, "com.other")).toBeNull();
    expect(windowFor(null, "com.other")).toBeNull();
  });
});

describe("the approved boundary of a step", () => {
  const effect = (step_id: string, device: DeviceSubBoundary, extra: object = {}) => ({
    step_id,
    driver: "local_browser",
    device,
    ...extra,
  });
  const other = "11111111-2222-4333-8444-555555555555";

  test("takes the step's own binding for files and computer", () => {
    const manifest = {
      effects: [
        effect("read", files),
        effect("other", {
          ...files,
          folders: [{ folder_id: "x", access: "read", root_digest: D("1") }],
        }),
      ],
    };
    expect(approvedBoundary(manifest, "read", DEVICE, "files")).toBe(files);
    expect(approvedBoundary(manifest, "read", other, "files")).toBeNull();
    expect(approvedBoundary(manifest, "read", DEVICE, "computer")).toBeNull();
    expect(approvedBoundary(manifest, "missing", DEVICE, "files")).toBeNull();
    expect(
      approvedBoundary(
        { effects: [effect("read", files, { call_path: ["child"] })] },
        "read",
        DEVICE,
        "files",
      ),
    ).toBeNull();
    expect(
      approvedBoundary({ effects: [{ step_id: "read" }] }, "read", DEVICE, "files"),
    ).toBeNull();
    expect(approvedBoundary({}, "read", DEVICE, "files")).toBeNull();
    expect(approvedBoundary(null, "read", DEVICE, "files")).toBeNull();
    expect(
      approvedBoundary(
        { effects: [effect("c", computer), effect("d", { ...computer, apps: [] })] },
        "c",
        DEVICE,
        "computer",
      ),
    ).toBe(computer);
  });

  test("a browser step carries every site the approval names for this device", () => {
    const open = {
      ...browser,
      sites: [{ origin: "https://b.example", private: false, site_digest: D("2") }],
    };
    const click: DeviceSubBoundary = { device_id: DEVICE, capability: "browser" };
    const second = {
      ...browser,
      sites: [{ origin: "https://a.example", private: true, site_digest: D("3") }],
    };
    const foreign = {
      ...browser,
      device_id: other,
      sites: [{ origin: "https://z.example", private: false, site_digest: D("4") }],
    };
    const manifest = {
      effects: [
        effect("open", open),
        effect("click", click),
        effect("again", second),
        effect("x", foreign),
      ],
    };
    expect(approvedBoundary(manifest, "click", DEVICE, "browser")).toEqual({
      device_id: DEVICE,
      capability: "browser",
      sites: [
        { origin: "https://a.example", private: true, site_digest: D("3") },
        { origin: "https://b.example", private: false, site_digest: D("2") },
      ],
    });
    expect(
      approvedBoundary({ effects: [effect("click", click)] }, "click", DEVICE, "browser"),
    ).toBe(click);
  });
});

describe("edges of the browser and computer bodies", () => {
  test("keys are plain key names only", () => {
    for (const key of ["!Enter", "Enter!", "Enter Tab"])
      expect(plan({ kind: "browser.press", body: { action: "key", key } }).ok).toBe(false);
  });

  test("fill, select and wait accept every documented form", () => {
    expect(
      plan({
        kind: "browser.fill",
        body: { mode: "fill", element: { role: "textbox", name: "Name" }, text: "Mike" },
      }).ok,
    ).toBe(true);
    expect(
      plan({
        kind: "browser.fill",
        body: { mode: "select", element: { role: "listbox", name: "Size" }, values: ["M", "L"] },
      }).ok,
    ).toBe(true);
    for (const state of ["load", "domcontentloaded"])
      expect(
        args({ kind: "browser.wait", method: "GET", body: { for: "load", state } }).args.state,
      ).toBe(state);
    expect(
      plan({ kind: "browser.wait", method: "GET", body: { for: "text", text: "Thank you" } }).ok,
    ).toBe(true);
    expect(plan({ kind: "browser.wait", method: "GET", body: { for: "text", text: "" } }).ok).toBe(
      false,
    );
  });

  test("open matches any of the approved sites", () => {
    const two: DeviceSubBoundary = {
      ...browser,
      sites: [
        { origin: "https://a.example", private: false, site_digest: D("1") },
        { origin: "https://shop.example", private: false, site_digest: D("c") },
      ],
    };
    expect(
      plan({ kind: "browser.open", body: { url: "https://shop.example/" }, boundary: two }).ok,
    ).toBe(true);
  });

  test("select and set_value carry their values; an app matches any approved app", () => {
    const two: DeviceSubBoundary = {
      ...computer,
      apps: [
        { app_id: "com.apple.TextEdit", app_digest: D("1") },
        { app_id: "com.apple.iWork.Numbers", app_digest: D("d") },
      ],
    };
    const element = { role: "popupbutton", name: "Font" };
    const select = args({
      kind: "computer.select",
      boundary: two,
      body: { app_id: "com.apple.iWork.Numbers", element, option: "Helvetica Neue" },
    });
    expect(select.args).toEqual({ option: "Helvetica Neue", boundary: two });
    expect(
      plan({
        kind: "computer.select",
        body: { app_id: "com.apple.iWork.Numbers", element, option: "" },
      }).ok,
    ).toBe(false);
    expect(
      args({
        kind: "computer.set_value",
        body: { app_id: "com.apple.iWork.Numbers", element, value: "Menlo" },
      }).args,
    ).toEqual({ value: "Menlo", boundary: computer });
  });

  test("a window id that is not text is never chosen", () => {
    expect(windowFor({ windows: [{ window_id: 4, bundle_id: "com.x" }] }, "com.x")).toBeNull();
  });
});
