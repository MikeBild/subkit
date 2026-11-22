import { describe, expect, test } from "bun:test";
import {
  ENGINE_DESKTOP_TARGET_NAMES,
  parseEngineDesktopArgs,
  selectEngineDesktopTargets,
} from "./engine-desktop-targets.ts";

const names = (argv: string[]) => {
  const parsed = parseEngineDesktopArgs(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.args.targets.map((t) => t.name);
};

describe("desktop engine targets", () => {
  test("are named after the platform the release builds for", () => {
    expect(ENGINE_DESKTOP_TARGET_NAMES).toBe("darwin-arm64|windows-x64");
  });

  test("without a target every target is built", () => {
    expect(names([])).toEqual(["darwin-arm64", "windows-x64"]);
    expect(selectEngineDesktopTargets(undefined)).toMatchObject({ ok: true });
  });

  test("one target builds only that target", () => {
    expect(names(["--target", "darwin-arm64"])).toEqual(["darwin-arm64"]);
    expect(names(["--target", "windows-x64"])).toEqual(["windows-x64"]);
  });

  test("keeps the output folder next to the target", () => {
    const parsed = parseEngineDesktopArgs(["--out", "out", "--target", "windows-x64"]);
    expect(parsed).toMatchObject({ ok: true, args: { out: "out" } });
    expect(parseEngineDesktopArgs([])).toMatchObject({ ok: true, args: { out: undefined } });
  });

  test.each([
    [
      ["--target", "mac-arm64"],
      "unknown engine target mac-arm64; use --target darwin-arm64|windows-x64",
    ],
    [["--target", "linux-x64"], "unknown engine target linux-x64"],
    [["--target", ""], "unknown engine target (empty)"],
    [["--target"], "--target needs a value"],
    [["--target", "--out"], "--target needs a value"],
    [["--target", "darwin-arm64", "--target", "windows-x64"], "--target may be given once"],
    [["--mac"], "unknown argument --mac"],
  ])("refuses %j", (argv, error) => {
    const parsed = parseEngineDesktopArgs(argv);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(error);
  });
});
