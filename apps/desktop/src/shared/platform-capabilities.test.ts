import { describe, expect, test } from "bun:test";
import {
  desktopPlatform,
  localBundle,
  offeredDeviceCapabilities,
  platformCapabilities,
  supports,
} from "./platform-capabilities.ts";

describe("platform capabilities", () => {
  test("only macOS on Apple Silicon and Windows x64 are desktop platforms", () => {
    expect(desktopPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(desktopPlatform("win32", "x64")).toBe("win32-x64");
    expect(desktopPlatform("darwin", "x64")).toBeNull();
    expect(desktopPlatform("win32", "arm64")).toBeNull();
    expect(desktopPlatform("linux", "x64")).toBeNull();
  });

  test("a Mac with Apple Silicon offers every local feature and the permission setup", () => {
    const mac = platformCapabilities("darwin", "arm64");
    expect(mac).toEqual({
      platform: "darwin-arm64",
      features: ["localWorkspace", "files", "browser", "computer"],
      macOnly: [],
      permissions: true,
    });
    expect(localBundle(mac)).toEqual({ engine: "mac/arm64/engine", postgres: "darwin-arm64" });
  });

  test("Windows x64 offers no local feature and names each one as Mac-only", () => {
    const windows = platformCapabilities("win32", "x64");
    expect(windows).toEqual({
      platform: "win32-x64",
      features: [],
      macOnly: ["localWorkspace", "files", "browser", "computer"],
      permissions: false,
    });
    expect(supports(windows, "localWorkspace")).toBe(false);
    expect(localBundle(windows)).toBeNull();
  });

  test("any other platform offers nothing", () => {
    for (const [platform, arch] of [
      ["darwin", "x64"],
      ["linux", "x64"],
    ] as const) {
      const other = platformCapabilities(platform, arch);
      expect(other.platform).toBeNull();
      expect(other.features).toEqual([]);
      expect(localBundle(other)).toBeNull();
    }
  });

  test("the runner announces only the device capabilities the platform supports", () => {
    const wanted = ["files", "browser", "computer"] as const;
    expect(offeredDeviceCapabilities(platformCapabilities("darwin", "arm64"), wanted)).toEqual([
      "files",
      "browser",
      "computer",
    ]);
    expect(offeredDeviceCapabilities(platformCapabilities("win32", "x64"), wanted)).toEqual([]);
  });
});
