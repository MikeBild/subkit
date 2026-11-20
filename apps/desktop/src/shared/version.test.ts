import { describe, expect, test } from "bun:test";
import { compareVersions, handshake, parseVersion } from "./version.ts";

describe("versions", () => {
  test("parses plain, prefixed and prerelease versions", () => {
    expect(parseVersion("11.0.0")).toEqual({ major: 11, minor: 0, patch: 0, prerelease: false });
    expect(parseVersion(" v1.2.3-beta.1+build ")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: true,
    });
    expect(parseVersion("11.0")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion(11)).toBeNull();
  });

  test("compares numerically, not lexically", () => {
    expect(compareVersions("10.25.0", "9.99.99")).toBe(1);
    expect(compareVersions("11.0.0", "11.0.0")).toBe(0);
    expect(compareVersions("11.0.9", "11.0.10")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "nope")).toBeNull();
  });
});

describe("handshake", () => {
  const base = {
    appVersion: "0.1.0",
    serverVersion: "11.2.0",
    minServerVersion: "11.0.0",
    minAppVersion: "0.1.0",
    desktopSupported: true,
    loginSupported: true,
  };

  test("is compatible when both sides meet the minimum", () => {
    expect(handshake(base)).toBe("compatible");
    expect(handshake({ ...base, minAppVersion: null })).toBe("compatible");
  });

  test("reports a server that is too old or does not know the desktop app", () => {
    expect(handshake({ ...base, serverVersion: "10.25.0" })).toBe("server-too-old");
    expect(handshake({ ...base, desktopSupported: false })).toBe("server-too-old");
    expect(handshake({ ...base, serverVersion: "dev" })).toBe("server-too-old");
  });

  test("reports an app that is too old", () => {
    expect(handshake({ ...base, minAppVersion: "0.2.0" })).toBe("app-too-old");
    expect(handshake({ ...base, minAppVersion: "garbage" })).toBe("app-too-old");
    expect(handshake({ ...base, loginSupported: false })).toBe("login-unsupported");
    expect(handshake({ ...base, loginSupported: false, serverVersion: "10.25.0" })).toBe(
      "server-too-old",
    );
  });
});
