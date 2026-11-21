import { describe, expect, test } from "bun:test";
import { DEVICE_COMMAND_STATES } from "./command-state.ts";
import { screenshotRef } from "./step-output.ts";
import {
  DEVICE_STEP_VIEW_STATES,
  hasScreenshot,
  STEP_TARGET_MAX,
  screenshotPng,
  stepTarget,
  stepTargets,
  stepViewState,
} from "./step-view.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const BASE64 = PNG.toString("base64");
const REF = screenshotRef(PNG);

describe("the state a device step shows", () => {
  test("open, closed and lost commands read as the step states of the timeline", () => {
    expect(DEVICE_COMMAND_STATES.map(stepViewState)).toEqual([
      "queued",
      "running",
      "done",
      "refused",
      "confirmation_required",
      "failed",
      "stopped",
      "stopped",
      "failed",
      "failed",
      "stopped",
    ]);
    for (const state of DEVICE_COMMAND_STATES)
      expect(DEVICE_STEP_VIEW_STATES).toContain(stepViewState(state));
  });
});

describe("the target a device step names", () => {
  test("files name the path, then the new path, then the folder", () => {
    expect(stepTarget("files.write", { folder_id: "docs", path: "a.md" })).toBe("a.md");
    expect(stepTarget("files.move", { folder_id: "docs", path: "", to_path: "b.md" })).toBe("b.md");
    expect(stepTarget("files.list", { folder_id: "docs" })).toBe("docs");
  });

  test("browser steps name the page, computer steps the app, never typed text", () => {
    expect(stepTarget("browser.open", { url: "https://shop.example/" })).toBe(
      "https://shop.example/",
    );
    expect(stepTarget("browser.fill", { text: "secret", element: { role: "textbox" } })).toBe("");
    expect(stepTarget("computer.type", { app_id: "com.apple.Numbers", text: "x" })).toBe(
      "com.apple.Numbers",
    );
  });

  test("a browser step without its own address names the page it is on", () => {
    expect(
      stepTargets([
        { kind: "browser.screenshot", args: {} },
        { kind: "browser.open", args: { url: "https://shop.example/cart?x=1" } },
        { kind: "files.list", args: { folder_id: "docs" } },
        { kind: "browser.screenshot", args: {} },
        { kind: "browser.open", args: { url: "not a url" } },
        { kind: "browser.press", args: { ref: "e1" } },
        { kind: "browser.open", args: { url: "ftp://files.example/" } },
        { kind: "browser.press", args: { ref: "e2" } },
        { kind: "browser.open", args: { url: "http://192.168.1.4:8080/admin" } },
        { kind: "browser.press", args: { ref: "e3" } },
      ]),
    ).toEqual([
      "",
      "https://shop.example/cart?x=1",
      "docs",
      "https://shop.example",
      "not a url",
      "https://shop.example",
      "ftp://files.example/",
      "https://shop.example",
      "http://192.168.1.4:8080/admin",
      "http://192.168.1.4:8080",
    ]);
  });

  test("without an open page the single approved site names it", () => {
    const site = (origin: string) => ({ origin, private: false, site_digest: "s".repeat(64) });
    expect(
      stepTargets([
        { kind: "browser.screenshot", args: { boundary: { sites: [site("https://a.example")] } } },
        {
          kind: "browser.screenshot",
          args: { boundary: { sites: [site("https://a.example"), site("https://b.example")] } },
        },
        { kind: "browser.screenshot", args: { boundary: { sites: [{ origin: 3 }] } } },
        { kind: "browser.screenshot", args: { boundary: { sites: [site("x".repeat(300))] } } },
        { kind: "computer.screenshot", args: { boundary: { sites: [site("https://a.example")] } } },
      ]),
    ).toEqual(["https://a.example", "", "", "x".repeat(STEP_TARGET_MAX), ""]);
  });

  test("odd arguments name nothing and long targets are cut", () => {
    expect(stepTarget("files.list", null)).toBe("");
    expect(stepTarget("files.list", "docs")).toBe("");
    expect(stepTarget("files.list", { path: 3, folder_id: "" })).toBe("");
    expect(stepTarget("browser.open", { url: "x".repeat(300) })).toHaveLength(STEP_TARGET_MAX);
  });
});

describe("a stored screenshot", () => {
  test("exists only for a finished screenshot whose answer is still kept", () => {
    expect(hasScreenshot("browser.screenshot", "done", true)).toBe(true);
    expect(hasScreenshot("computer.screenshot", "done", true)).toBe(true);
    expect(hasScreenshot("browser.screenshot", "done", false)).toBe(false);
    expect(hasScreenshot("browser.screenshot", "failed", true)).toBe(false);
    expect(hasScreenshot("browser.snapshot", "done", true)).toBe(false);
  });

  test("hands back the PNG only when it matches its hash", () => {
    const done = (output: unknown, screenshot_ref = REF) =>
      ({ status: "done", output, evidence: { screenshot_ref } }) as const;
    expect(screenshotPng(done({ image: { base64: BASE64 } }))).toEqual(PNG);
    expect(screenshotPng(done({ data: BASE64 }))).toEqual(PNG);
    expect(screenshotPng(done({ image: { base64: 5 }, data: BASE64 }))).toEqual(PNG);
    expect(screenshotPng(done({ data: BASE64 }, "sha256:00"))).toBeNull();
    expect(screenshotPng(done({ data: "" }))).toBeNull();
    expect(screenshotPng(done({ data: 5 }))).toBeNull();
    expect(screenshotPng(done(null))).toBeNull();
    expect(screenshotPng(done("text"))).toBeNull();
    expect(screenshotPng({ status: "failed", code: "x", detail: "" })).toBeNull();
    expect(screenshotPng(null)).toBeNull();
  });
});
