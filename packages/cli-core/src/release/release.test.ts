import { describe, expect, test } from "bun:test";
import {
  CLI_ASSETS,
  releaseAssetFor,
  releaseDownloadBase,
  releaseFileUrls,
  releaseTarget,
  versionFromReleaseLocation,
} from "./assets.ts";
import { compatibilityWarning, engineCompatibility, isIncompatible } from "./compatibility.ts";
import {
  backgroundCheckAllowed,
  refreshDue,
  runsAsCompiledBinary,
  UPDATE_CHECK_INTERVAL_MS,
  updateAction,
  updateHint,
} from "./update-policy.ts";
import { compareVersions, isDevBuild, isNewer, parseVersion, stableVersion } from "./version.ts";

function order(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`unparsable: ${a} ${b}`);
  return compareVersions(left, right);
}

describe("release version", () => {
  test("parses plain, prefixed and prerelease versions", () => {
    expect(parseVersion("12.1.0")).toEqual({ major: 12, minor: 1, patch: 0, prerelease: [] });
    expect(parseVersion("v3.0.2")?.major).toBe(3);
    expect(parseVersion(" 1.2.3-rc.1+build.7 ")?.prerelease).toEqual(["rc", "1"]);
  });

  test("rejects anything that is not a full version", () => {
    for (const text of ["", "1.2", "1.2.3.4", "01.2.3", "latest", "1.2.x"]) {
      expect(parseVersion(text)).toBeNull();
    }
  });

  test("orders by precedence, prereleases below the release", () => {
    expect(order("1.10.0", "1.9.9")).toBe(1);
    expect(order("2.0.0", "2.0.0")).toBe(0);
    expect(order("2.0.0-rc.1", "2.0.0")).toBe(-1);
    expect(order("2.0.0-rc.2", "2.0.0-rc.10")).toBe(-1);
    expect(order("2.0.0-alpha", "2.0.0-alpha.1")).toBe(-1);
    expect(order("2.0.0-1", "2.0.0-alpha")).toBe(-1);
    expect(order("2.0.0-beta", "2.0.0-alpha")).toBe(1);
  });

  test("isNewer is false for unparsable input on either side", () => {
    expect(isNewer("12.1.0", "12.0.9")).toBe(true);
    expect(isNewer("12.0.0", "12.0.0")).toBe(false);
    expect(isNewer("garbage", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "garbage")).toBe(false);
  });

  test("recognises development builds", () => {
    expect(isDevBuild("0.0.0-dev")).toBe(true);
    expect(isDevBuild("dev")).toBe(true);
    expect(isDevBuild("12.1.0")).toBe(false);
    expect(isDevBuild("12.1.0-rc.1")).toBe(false);
  });
});

describe("release assets", () => {
  test("publishes one CLI asset per supported platform", () => {
    expect(CLI_ASSETS).toEqual([
      "subkit-darwin-arm64",
      "subkit-linux-x64",
      "subkit-linux-arm64",
      "subkit-windows-x64.exe",
    ]);
  });

  test("maps Node platform names to release targets", () => {
    expect(releaseTarget("win32", "x64")).toEqual({ os: "windows", arch: "x64" });
    expect(releaseTarget("freebsd", "x64")).toBeNull();
    expect(releaseTarget("linux", "ia32")).toBeNull();
  });

  test("selects the CLI asset only for built targets", () => {
    expect(releaseAssetFor("subkit", "darwin", "arm64")).toBe("subkit-darwin-arm64");
    expect(releaseAssetFor("subkit", "linux", "arm64")).toBe("subkit-linux-arm64");
    expect(releaseAssetFor("subkit", "win32", "x64")).toBe("subkit-windows-x64.exe");
    expect(releaseAssetFor("subkit", "darwin", "x64")).toBeNull();
    expect(releaseAssetFor("subkit", "win32", "arm64")).toBeNull();
  });

  test("selects the engine asset for its single target", () => {
    expect(releaseAssetFor("engine", "linux", "x64")).toBe("engine_linux_x64");
    expect(releaseAssetFor("engine", "darwin", "arm64")).toBeNull();
    expect(releaseAssetFor("other", "linux", "x64")).toBeNull();
  });

  test("builds stable latest and pinned download bases", () => {
    expect(releaseDownloadBase("latest")).toBe(
      "https://github.com/MikeBild/subkit/releases/latest/download",
    );
    expect(releaseDownloadBase("v12.1.0", "https://stub.test/releases/")).toBe(
      "https://stub.test/releases/download/v12.1.0",
    );
  });

  test("lists the binary, checksums, signature and notices of one release", () => {
    expect(releaseFileUrls("https://e.test/install/", "subkit-linux-x64")).toEqual([
      { name: "subkit-linux-x64", url: "https://e.test/install/subkit-linux-x64" },
      { name: "SHA256SUMS", url: "https://e.test/install/SHA256SUMS" },
      { name: "SHA256SUMS.sig", url: "https://e.test/install/SHA256SUMS.sig" },
      { name: "LICENSE", url: "https://e.test/install/LICENSE" },
      { name: "THIRD_PARTY_NOTICES.txt", url: "https://e.test/install/THIRD_PARTY_NOTICES.txt" },
    ]);
  });
});

describe("update policy", () => {
  const allowed = {
    enabledInSettings: true,
    disabledByEnv: false,
    stderrIsTTY: true,
    command: "workflows",
    machineReadable: false,
    currentVersion: "12.1.0",
  };

  test("checks in the background for an interactive release build", () => {
    expect(backgroundCheckAllowed(allowed)).toBe(true);
    expect(backgroundCheckAllowed({ ...allowed, command: undefined })).toBe(true);
  });

  test("stays silent when disabled, piped, machine-readable, a dev build or a quiet command", () => {
    expect(backgroundCheckAllowed({ ...allowed, enabledInSettings: false })).toBe(false);
    expect(backgroundCheckAllowed({ ...allowed, disabledByEnv: true })).toBe(false);
    expect(backgroundCheckAllowed({ ...allowed, stderrIsTTY: false })).toBe(false);
    expect(backgroundCheckAllowed({ ...allowed, machineReadable: true })).toBe(false);
    expect(backgroundCheckAllowed({ ...allowed, currentVersion: "0.0.0-dev" })).toBe(false);
    expect(backgroundCheckAllowed({ ...allowed, command: "update" })).toBe(false);
    expect(backgroundCheckAllowed({ ...allowed, command: "mcp" })).toBe(false);
  });

  test("refreshes once a day and after a clock jump backwards", () => {
    const now = 10 * UPDATE_CHECK_INTERVAL_MS;
    expect(refreshDue(null, now)).toBe(true);
    expect(refreshDue(now - 1000, now)).toBe(false);
    expect(refreshDue(now - UPDATE_CHECK_INTERVAL_MS, now)).toBe(true);
    expect(refreshDue(now + 1000, now)).toBe(true);
  });

  test("hints in one line only when a newer version exists", () => {
    const hint = updateHint("12.1.0", "12.2.0");
    expect(hint).toBe(
      "subkit 12.2.0 is available (you have 12.1.0). Run `subkit update` to install it.",
    );
    expect(hint?.includes("\n")).toBe(false);
    expect(updateHint("12.1.0", "12.1.0")).toBeNull();
    expect(updateHint("12.1.0", null)).toBeNull();
  });

  test("replaces only a compiled binary, never the runtime it was started with", () => {
    expect(runsAsCompiledBinary("/home/a/.local/bin/subkit")).toBe(true);
    expect(runsAsCompiledBinary("C:\\Users\\a\\subkit.exe")).toBe(true);
    expect(runsAsCompiledBinary("/opt/homebrew/bin/bun")).toBe(false);
    expect(runsAsCompiledBinary("C:\\bun\\bun.exe")).toBe(false);
    expect(runsAsCompiledBinary("/usr/bin/node")).toBe(false);
  });
});

describe("engine compatibility", () => {
  test("classifies by major and minor version", () => {
    expect(engineCompatibility("12.1.0", "12.1.0")).toBe("match");
    expect(engineCompatibility("12.1.3", "12.1.0")).toBe("compatible");
    expect(engineCompatibility("12.0.0", "12.1.0")).toBe("cli_older");
    expect(engineCompatibility("13.0.0", "12.9.0")).toBe("cli_newer");
    expect(engineCompatibility("0.0.0-dev", "12.1.0")).toBe("unknown");
    expect(engineCompatibility("12.1.0", "unknown")).toBe("unknown");
  });

  test("only minor or major drift is incompatible", () => {
    expect(isIncompatible("cli_older")).toBe(true);
    expect(isIncompatible("cli_newer")).toBe(true);
    expect(isIncompatible("compatible")).toBe(false);
    expect(isIncompatible("unknown")).toBe(false);
  });

  test("warns with the command that aligns the CLI to the engine", () => {
    expect(compatibilityWarning("12.0.0", "12.1.0")).toBe(
      "subkit 12.0.0 is older than the engine (12.1.0). Run `subkit update --match-engine`.",
    );
    expect(compatibilityWarning("12.2.0", "12.1.0")).toContain("newer than the engine");
    expect(compatibilityWarning("12.1.1", "12.1.0")).toBeNull();
  });
});

describe("update action", () => {
  const flags = { check: false, force: false, exact: false };

  test("installs only a newer latest release", () => {
    expect(updateAction("12.1.0", "12.2.0", flags)).toBe("install");
    expect(updateAction("12.1.0", "12.1.0", flags)).toBe("up_to_date");
    expect(updateAction("12.2.0", "12.1.0", flags)).toBe("up_to_date");
  });

  test("matching the engine installs any different version, also an older one", () => {
    expect(updateAction("12.2.0", "12.1.0", { ...flags, exact: true })).toBe("install");
    expect(updateAction("12.1.0", "12.1.0", { ...flags, exact: true })).toBe("up_to_date");
  });

  test("--check reports instead of installing, --force reinstalls", () => {
    expect(updateAction("12.1.0", "12.2.0", { ...flags, check: true })).toBe("report");
    expect(updateAction("12.1.0", "12.1.0", { ...flags, force: true })).toBe("install");
  });
});

describe("release location", () => {
  test("reads the version from the latest-release redirect", () => {
    expect(
      versionFromReleaseLocation("https://github.com/MikeBild/subkit/releases/tag/v12.1.0"),
    ).toBe("12.1.0");
    expect(versionFromReleaseLocation("/o/r/releases/tag/12.1.0-rc.1")).toBe("12.1.0-rc.1");
    expect(versionFromReleaseLocation("https://github.com/MikeBild/subkit/releases")).toBeNull();
    expect(versionFromReleaseLocation("https://x/releases/tag/nightly")).toBeNull();
    expect(versionFromReleaseLocation(null)).toBeNull();
  });
});

describe("stableVersion", () => {
  test("rebuilds a stable version from its numbers", () => {
    expect(stableVersion("v12.1.0")).toBe("12.1.0");
    expect(stableVersion(" 3.0.10 ")).toBe("3.0.10");
  });

  test("refuses prereleases and anything that is not a version", () => {
    for (const text of ["1.2.3-beta.1", "1.2", "latest", "", "1.2.3/../x"])
      expect(stableVersion(text)).toBeNull();
  });
});
