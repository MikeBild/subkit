import { describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { parseCommandArgs } from "../../../devices/core/command-args.ts";
import {
  type ArgsContext,
  BECAUSE_FIELD,
  browserPartition,
  CLASSIFY_ACTION,
  commandArgsOf,
  DEVICE_TOOL_NAMES,
  DEVICE_TOOL_SPECS,
  deviceToolSpec,
  isSnapshotTool,
} from "./catalog.ts";

const CONTEXT: ArgsContext = { partition: "c-1", window_id: null, state_hash: null };

function spec(name: string) {
  const found = deviceToolSpec(name);
  if (!found) throw new Error(name);
  return found;
}

function args(name: string, input: Record<string, unknown>, context = CONTEXT) {
  const tool = spec(name);
  const parsed = tool.input.parse(input) as Record<string, unknown>;
  return commandArgsOf(tool, parsed, context);
}

function runnerAccepts(name: string, input: Record<string, unknown>, context = CONTEXT) {
  return parseCommandArgs(spec(name).kind, args(name, input, context));
}

describe("device tool catalog", () => {
  test("names, capabilities and command kinds line up", () => {
    expect(DEVICE_TOOL_SPECS.map((tool) => [tool.name, tool.kind, tool.ref])).toEqual([
      ["browser_open", "browser.open", null],
      ["browser_snapshot", "browser.snapshot", null],
      ["browser_press", "browser.press", "browser"],
      ["browser_fill", "browser.fill", "browser"],
      ["browser_wait", "browser.wait", null],
      ["browser_extract", "browser.extract", "browser"],
      ["browser_screenshot", "browser.screenshot", null],
      ["browser_handover", "browser.handover", null],
      ["computer_handover", "computer.handover", null],
      ["computer_apps", "computer.apps", null],
      ["computer_snapshot", "computer.snapshot", null],
      ["computer_screenshot", "computer.screenshot", null],
      ["computer_press", "computer.press", "computer"],
      ["computer_focus", "computer.focus", "computer"],
      ["computer_select", "computer.select", "computer"],
      ["computer_set_value", "computer.set_value", "computer"],
      ["computer_type", "computer.type", "computer"],
      ["computer_key", "computer.key", "computer"],
      ["computer_scroll", "computer.scroll", "computer"],
      ["files_list", "files.list", null],
      ["files_read", "files.read_text", null],
      ["files_write", "files.write", null],
      ["files_mkdir", "files.mkdir", null],
      ["files_move", "files.move", null],
      ["files_trash", "files.trash", null],
    ]);
    for (const tool of DEVICE_TOOL_SPECS) {
      expect(tool.kind.startsWith(`${tool.capability}.`)).toBe(true);
      expect(tool.name.startsWith(`${tool.capability}_`)).toBe(true);
      expect(tool.description.length).toBeGreaterThan(10);
    }
    expect(DEVICE_TOOL_NAMES.size).toBe(DEVICE_TOOL_SPECS.length);
    expect(DEVICE_TOOL_NAMES.has("browser_press")).toBe(true);
    expect(deviceToolSpec("call_connector")).toBeNull();
  });

  test("snapshot tools are the two readers of refs", () => {
    expect(isSnapshotTool("browser_snapshot")).toBe(true);
    expect(isSnapshotTool("computer_snapshot")).toBe(true);
    expect(isSnapshotTool("browser_extract")).toBe(false);
  });

  test("every action that commits takes the person's quote", () => {
    for (const name of [
      "browser_press",
      "browser_fill",
      "computer_press",
      "computer_select",
      "computer_set_value",
      "computer_type",
      "computer_key",
      "files_write",
      "files_mkdir",
      "files_move",
      "files_trash",
    ]) {
      expect(Object.keys(spec(name).input.shape)).toContain("because");
    }
    expect(BECAUSE_FIELD.parse(undefined)).toBeUndefined();
    expect(() => BECAUSE_FIELD.parse("x".repeat(401))).toThrow();
    expect(() =>
      spec("browser_open").input.parse({ url: "https://a.example", extra: 1 }),
    ).toThrow();
  });

  test("model-facing fields are bounded", () => {
    expect(() => spec("browser_press").input.parse({ action: "click", ref: "x1" })).toThrow();
    expect(() => spec("browser_press").input.parse({ action: "key", key: "a b" })).toThrow();
    expect(() => spec("browser_press").input.parse({ action: "click", snapshot_id: "" })).toThrow();
    expect(() =>
      spec("browser_press").input.parse({ action: "click", snapshot_id: "x".repeat(101) }),
    ).toThrow();
    expect(() => spec("computer_press").input.parse({ ref: "e1" })).toThrow();
    expect(() => spec("computer_snapshot").input.parse({ window_id: "-w" })).toThrow();
    expect(() => spec("files_list").input.parse({ path: "/" })).toThrow();
    expect(() =>
      spec("browser_fill").input.parse({ ref: "e1", snapshot_id: "s", values: [] }),
    ).toThrow();
    expect(() => spec("browser_wait").input.parse({ for: "ms", ms: 30_001 })).toThrow();
    expect(() => spec("browser_wait").input.parse({ for: "text", text: "" })).toThrow();
    expect(() => spec("computer_select").input.parse({ ref: "@s1:e1", option: "" })).toThrow();
    expect(() =>
      spec("computer_scroll").input.parse({ ref: "@s1:e1", direction: "up", amount: 21 }),
    ).toThrow();
    expect(() => spec("computer_key").input.parse({ window_id: "w1", keys: "" })).toThrow();
    expect(() => spec("browser_open").input.parse({ url: "" })).toThrow();
    expect(() =>
      spec("browser_fill").input.parse({ ref: "e1", snapshot_id: "s", text: "x".repeat(10_001) }),
    ).toThrow();
    expect(() =>
      spec("browser_fill").input.parse({ ref: "e1", snapshot_id: "s", values: ["x".repeat(1001)] }),
    ).toThrow();
    expect(spec("browser_fill").input.parse({ ref: "e1", snapshot_id: "s" })).toMatchObject({
      mode: "fill",
    });
    expect(spec("computer_scroll").input.parse({ ref: "@s1:e1", direction: "up" })).toMatchObject({
      amount: 3,
    });
    expect(spec("files_write").input.parse({ path: "/a/b", text: "" })).toMatchObject({
      replace: false,
    });
  });

  test("the partition belongs to one task or one chat", () => {
    expect(browserPartition({ kind: "task", id: "AB-12" })).toBe("t-ab12");
    expect(browserPartition({ kind: "chat", id: "9f2c4e7a-1b2c-4d5e-8f90-1234567890ab" })).toBe(
      "c-9f2c4e7a1b2c4d5e8f901234567890ab",
    );
    expect(browserPartition({ kind: "chat", id: "x".repeat(80) })).toHaveLength(64);
  });
});

describe("tool input becomes the runner's command arguments", () => {
  test.each([
    [
      "browser_open",
      { url: "https://shop.example" },
      { partition: "c-1", url: "https://shop.example" },
    ],
    ["browser_snapshot", {}, { partition: "c-1" }],
    ["browser_screenshot", {}, { partition: "c-1" }],
    [
      "browser_press",
      { action: "click", ref: "e3", snapshot_id: "s", key: "Enter", because: "q" },
      { partition: "c-1", action: "click", ref: "e3" },
    ],
    [
      "browser_press",
      { action: "key", key: "Enter", ref: "e3" },
      { partition: "c-1", action: "key", key: "Enter" },
    ],
    [
      "browser_press",
      { action: "scroll", direction: "down", ref: "e3" },
      { partition: "c-1", action: "scroll", direction: "down" },
    ],
    [
      "browser_fill",
      { ref: "e2", snapshot_id: "s", text: "Anna" },
      { partition: "c-1", mode: "fill", ref: "e2", text: "Anna" },
    ],
    [
      "browser_fill",
      { ref: "e2", snapshot_id: "s", mode: "type" },
      { partition: "c-1", mode: "type", ref: "e2", text: "" },
    ],
    [
      "browser_fill",
      { ref: "e2", snapshot_id: "s", mode: "select", values: ["2"], text: "x" },
      { partition: "c-1", mode: "select", ref: "e2", values: ["2"] },
    ],
    ["browser_wait", { for: "load", text: "x" }, { partition: "c-1", for: "load" }],
    [
      "browser_wait",
      { for: "text", text: "Done", ms: 3 },
      { partition: "c-1", for: "text", text: "Done" },
    ],
    ["browser_wait", { for: "ms", ms: 50, text: "x" }, { partition: "c-1", for: "ms", ms: 50 }],
    ["browser_extract", {}, { partition: "c-1" }],
    ["browser_extract", { ref: "e4", snapshot_id: "s" }, { partition: "c-1", ref: "e4" }],
  ])("%s %j", (name, input, expected) => {
    expect(args(name, input)).toEqual(expected);
    expect(runnerAccepts(name, input).ok).toBe(true);
  });

  test("computer actions take the window and state of the latest snapshot", () => {
    const context = { partition: "c-1", window_id: "w1", state_hash: "a".repeat(64) };
    expect(args("computer_apps", {}, context)).toEqual({});
    expect(args("computer_snapshot", { window_id: "w2" }, context)).toEqual({ window_id: "w2" });
    expect(args("computer_screenshot", { window_id: "w2" }, context)).toEqual({ window_id: "w2" });
    expect(args("computer_key", { window_id: "w2", keys: "cmd+s" }, context)).toEqual({
      window_id: "w2",
      keys: "cmd+s",
      state_hash: "a".repeat(64),
    });
    expect(args("computer_press", { ref: "@s1:e2", because: "q" }, context)).toEqual({
      window_id: "w1",
      ref: "@s1:e2",
      state_hash: "a".repeat(64),
    });
    expect(args("computer_type", { ref: "@s1:e2", text: "Hi" }, context)).toMatchObject({
      text: "Hi",
    });
    expect(args("computer_set_value", { ref: "@s1:e2", value: "3" }, context)).toMatchObject({
      value: "3",
    });
    expect(args("computer_select", { ref: "@s1:e2", option: "B" }, context)).toMatchObject({
      option: "B",
    });
    expect(args("computer_scroll", { ref: "@s1:e2", direction: "up" }, context)).toMatchObject({
      direction: "up",
      amount: 3,
    });
    expect(args("computer_focus", { ref: "@s1:e2" }, CONTEXT)).toEqual({ ref: "@s1:e2" });
    expect(args("computer_key", { window_id: "w2", keys: "tab" }, CONTEXT)).toEqual({
      window_id: "w2",
      keys: "tab",
    });
    for (const [name, input] of [
      ["computer_press", { ref: "@s1:e2" }],
      ["computer_type", { ref: "@s1:e2", text: "Hi" }],
      ["computer_key", { window_id: "w2", keys: "cmd+s" }],
      ["computer_scroll", { ref: "@s1:e2", direction: "up" }],
    ] as const) {
      expect(runnerAccepts(name, input, context).ok).toBe(true);
    }
  });

  test("files use absolute paths in personal mode", () => {
    expect(args("files_list", { path: "/Users/a/Docs" })).toEqual({
      target: { absolute: "/Users/a/Docs" },
    });
    expect(args("files_read", { path: "/Users/a/x.txt" })).toEqual({
      target: { absolute: "/Users/a/x.txt" },
    });
    expect(args("files_mkdir", { path: "/Users/a/New", because: "q" })).toEqual({
      target: { absolute: "/Users/a/New" },
    });
    expect(args("files_write", { path: "/Users/a/x.txt", text: "hi", replace: true })).toEqual({
      target: { absolute: "/Users/a/x.txt" },
      content: { encoding: "utf8", text: "hi" },
      replace: true,
    });
    expect(args("files_write", { path: "/Users/a/x.txt", text: "hi" })).toMatchObject({
      replace: false,
    });
    expect(args("files_move", { from: "/Users/a/x", to: "/Users/a/y" })).toEqual({
      items: [{ from: { absolute: "/Users/a/x" }, to: { absolute: "/Users/a/y" } }],
    });
    expect(args("files_trash", { path: "/Users/a/x" })).toEqual({
      items: [{ absolute: "/Users/a/x" }],
    });
    for (const [name, input] of [
      ["files_list", { path: "/Users/a/Docs" }],
      ["files_write", { path: "/Users/a/x.txt", text: "hi" }],
      ["files_move", { from: "/Users/a/x", to: "/Users/a/y" }],
      ["files_trash", { path: "/Users/a/x" }],
    ] as const) {
      expect(runnerAccepts(name, input).ok).toBe(true);
    }
    expect(commandArgsOf(spec("files_list"), { path: 3 }, CONTEXT)).toEqual({
      target: { absolute: undefined },
    });
  });
});

describe("model-facing shapes", () => {
  const props = (name: string) =>
    (z.toJSONSchema(spec(name).input) as { properties: Record<string, { description?: string }> })
      .properties;

  test("every free field explains itself to the model", () => {
    expect(props("browser_press").because?.description).toStartWith("Only for an action");
    expect(props("browser_press").snapshot_id?.description).toStartWith("The snapshot_id");
    expect(props("browser_press").ref?.description).toStartWith("A ref from that snapshot");
    expect(props("computer_press").ref?.description).toStartWith("A ref from the latest window");
    expect(props("files_list").path?.description).toStartWith("An absolute path");
  });

  test("refs and windows match exactly", () => {
    const browser = spec("browser_extract").input;
    expect(browser.safeParse({ ref: "e123456" }).success).toBe(true);
    expect(browser.safeParse({ ref: "@e12" }).success).toBe(true);
    expect(browser.safeParse({ ref: "xe1" }).success).toBe(false);
    expect(browser.safeParse({ ref: "e1x" }).success).toBe(false);
    const computer = spec("computer_focus").input;
    expect(computer.safeParse({ ref: "@s12ab:e1" }).success).toBe(true);
    expect(computer.safeParse({ ref: "@s1:e123" }).success).toBe(true);
    expect(computer.safeParse({ ref: "x@s1:e1" }).success).toBe(false);
    expect(computer.safeParse({ ref: "@s1:e1x" }).success).toBe(false);
    expect(computer.safeParse({ ref: "@s1:e0" }).success).toBe(false);
    const window = spec("computer_snapshot").input;
    expect(window.safeParse({ window_id: "w12" }).success).toBe(true);
    expect(window.safeParse({ window_id: "w1!" }).success).toBe(false);
  });

  test("directions, modes and amounts", () => {
    for (const direction of ["up", "down", "left", "right"]) {
      expect(spec("browser_press").input.safeParse({ action: "scroll", direction }).success).toBe(
        true,
      );
      expect(spec("computer_scroll").input.safeParse({ ref: "@s1:e1", direction }).success).toBe(
        true,
      );
    }
    for (const mode of ["fill", "type", "select"]) {
      expect(
        spec("browser_fill").input.safeParse({ ref: "e1", snapshot_id: "s", mode }).success,
      ).toBe(true);
    }
    expect(
      spec("computer_scroll").input.safeParse({ ref: "@s1:e1", direction: "up", amount: 0 })
        .success,
    ).toBe(false);
    expect(
      spec("computer_scroll").input.safeParse({ ref: "@s1:e1", direction: "up", amount: 20 })
        .success,
    ).toBe(true);
    const big = "x".repeat(10 * 1024 * 1024);
    expect(spec("files_write").input.safeParse({ path: "/a/b", text: big }).success).toBe(true);
    expect(spec("files_write").input.safeParse({ path: "/a/b", text: `${big}x` }).success).toBe(
      false,
    );
  });

  test("the classifier sees each action as what it is", () => {
    expect(CLASSIFY_ACTION).toEqual({
      browser_press: "click",
      browser_fill: "fill",
      computer_press: "click",
      computer_select: "select",
      computer_set_value: "fill",
      computer_type: "fill",
      computer_key: "key",
    });
  });

  test("a click never carries a scroll direction", () => {
    expect(args("browser_press", { action: "click", ref: "e1", direction: "down" })).toEqual({
      partition: "c-1",
      action: "click",
      ref: "e1",
    });
  });
});

describe("handing a step to the person", () => {
  test("names the reason, in the conversation's browser or on the Mac", () => {
    expect(args("browser_handover", { reason: "Anmeldung" })).toEqual({
      partition: CONTEXT.partition,
      reason: "Anmeldung",
    });
    expect(args("computer_handover", { reason: "Passwort eingeben" })).toEqual({
      reason: "Passwort eingeben",
    });
  });
});
