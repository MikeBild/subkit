import { describe, expect, test } from "bun:test";
import { missingPermissions } from "./permission-gap.ts";

describe("missing macOS permissions from a heartbeat", () => {
  test("a device without computer use misses nothing", () => {
    expect(
      missingPermissions({ capabilities: ["files", "browser"], permissions: { screen: false } }),
    ).toEqual([]);
  });

  test("names each permission computer use still lacks", () => {
    expect(
      missingPermissions({
        capabilities: ["files", "computer"],
        permissions: { accessibility: true, screen: false },
      }),
    ).toEqual(["screen"]);
    expect(missingPermissions({ capabilities: ["computer"], permissions: {} })).toEqual([
      "accessibility",
      "screen",
    ]);
  });

  test("a granted device misses nothing", () => {
    expect(
      missingPermissions({
        capabilities: ["computer"],
        permissions: { accessibility: true, screen: true },
      }),
    ).toEqual([]);
  });

  test("odd reports count as nothing granted or nothing offered", () => {
    expect(missingPermissions(null)).toEqual([]);
    expect(missingPermissions([])).toEqual([]);
    expect(missingPermissions({ capabilities: "computer" })).toEqual([]);
    expect(missingPermissions({ capabilities: ["computer"] })).toEqual(["accessibility", "screen"]);
    expect(missingPermissions({ capabilities: ["computer"], permissions: [true] })).toEqual([
      "accessibility",
      "screen",
    ]);
    expect(
      missingPermissions({ capabilities: ["computer"], permissions: { accessibility: "yes" } }),
    ).toEqual(["accessibility", "screen"]);
  });
});
