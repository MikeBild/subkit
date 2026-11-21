import { describe, expect, test } from "bun:test";
import {
  ACTION_TIMEOUT_MS,
  clickArgs,
  comboFor,
  focusArgs,
  helperEnv,
  INVENTORY_TIMEOUT_MS,
  listAppsArgs,
  listWindowsArgs,
  pointerClickArgs,
  pressArgs,
  SNAPSHOT_MAX_DEPTH,
  SNAPSHOT_TIMEOUT_MS,
  screenshotArgs,
  scrollArgs,
  selectArgs,
  setValueArgs,
  snapshotArgs,
  typeArgs,
} from "./computer-commands.ts";

const REF = "@s8f3k2p9:e8";

describe("helper argv", () => {
  test("inventory commands", () => {
    expect(listWindowsArgs()).toEqual(["list-windows", "--timeout-ms", "5000"]);
    expect(listAppsArgs()).toEqual(["list-apps", "--timeout-ms", "5000"]);
    expect(INVENTORY_TIMEOUT_MS).toBe(5000);
  });

  test("a snapshot reads one window completely with bounds", () => {
    expect(snapshotArgs("w-7")).toEqual([
      "snapshot",
      "--window-id",
      "w-7",
      "--include-bounds",
      "--compact",
      "--max-depth",
      "50",
      "--timeout-ms",
      "3000",
    ]);
    expect([SNAPSHOT_MAX_DEPTH, SNAPSHOT_TIMEOUT_MS]).toEqual([50, 3000]);
  });

  test("a screenshot captures one window only", () => {
    expect(screenshotArgs("w-7")).toEqual(["screenshot", "--window-id", "w-7"]);
  });

  test("ref actions", () => {
    expect(clickArgs(REF)).toEqual(["click", REF, "--timeout-ms", "5000"]);
    expect(focusArgs(REF)).toEqual(["focus", REF, "--timeout-ms", "5000"]);
    expect(scrollArgs(REF, "up", 4)).toEqual([
      "scroll",
      REF,
      "--direction",
      "up",
      "--amount",
      "4",
      "--timeout-ms",
      "5000",
    ]);
    expect(ACTION_TIMEOUT_MS).toBe(5000);
  });

  test("text goes through stdin, never through argv", () => {
    expect(typeArgs(REF)).toEqual(["type", REF, "--stdin"]);
    expect(setValueArgs(REF)).toEqual(["set-value", REF, "--stdin"]);
  });

  test("a select option sits after the end of the flags", () => {
    expect(selectArgs(REF, "--headed")).toEqual([
      "select",
      REF,
      "--timeout-ms",
      "5000",
      "--",
      "--headed",
    ]);
  });

  test("a key combo goes to one window", () => {
    expect(pressArgs("cmd+s", "w-7")).toEqual(["press", "cmd+s", "--window-id", "w-7"]);
  });

  test("the pointer fallback is headed and rounds coordinates", () => {
    expect(pointerClickArgs(10.4, 20.6)).toEqual(["--headed", "mouse-click", "--xy", "10,21"]);
  });
});

describe("comboFor", () => {
  test("maps allowed combos onto the helper key names", () => {
    expect(comboFor("cmd+s")).toEqual({ ok: true, combo: "cmd+s" });
    expect(comboFor("Command+Shift+Z")).toEqual({ ok: true, combo: "shift+cmd+z" });
    expect(comboFor("ctrl+alt+a")).toEqual({ ok: true, combo: "ctrl+alt+a" });
    expect(comboFor("esc")).toEqual({ ok: true, combo: "escape" });
    expect(comboFor("Enter")).toEqual({ ok: true, combo: "return" });
    expect(comboFor("backspace")).toEqual({ ok: true, combo: "delete" });
    expect(comboFor("f5")).toEqual({ ok: true, combo: "f5" });
    expect(comboFor("shift+f10")).toEqual({ ok: true, combo: "shift+f10" });
    expect(comboFor("pagedown")).toEqual({ ok: true, combo: "pagedown" });
    expect(comboFor("cmd+comma")).toEqual({ ok: true, combo: "cmd+comma" });
  });

  test("refuses the fixed shortcut bans", () => {
    for (const keys of ["cmd+q", "cmd+tab", "cmd+space", "cmd+shift+3", "ctrl+cmd+q", "fn+f1"]) {
      expect(comboFor(keys)).toEqual({ ok: false, code: "blocked_shortcut" });
    }
  });

  test("refuses keys the helper should never see", () => {
    for (const keys of ["cmd+--headed", "f13", "cmd+", "ab", "cmd+é", "cmd+f0"]) {
      expect(comboFor(keys)).toEqual({ ok: false, code: "bad_key" });
    }
  });
});

describe("helperEnv", () => {
  test("passes only the private state root", () => {
    expect(helperEnv("/Users/x/Library/Application Support/SubKit/computer")).toEqual({
      AGENT_DESKTOP_HOME: "/Users/x/Library/Application Support/SubKit/computer",
    });
  });
});
