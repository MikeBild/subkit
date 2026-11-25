import { describe, expect, test } from "bun:test";
import { type PermissionAsk, permissionGranted, wantsMicrophone } from "./permission-policy.ts";

const SERVER = "https://subkit.example";

const ask = (overrides: Partial<PermissionAsk>): PermissionAsk => ({
  permission: "notifications",
  requester: SERVER,
  serverOrigin: SERVER,
  mediaTypes: [],
  ...overrides,
});

describe("permissionGranted", () => {
  test("allows notifications and sanitized clipboard writes from the server", () => {
    expect(permissionGranted(ask({}))).toBe(true);
    expect(permissionGranted(ask({ permission: "clipboard-sanitized-write" }))).toBe(true);
  });

  test("allows the microphone for dictation from the server", () => {
    expect(permissionGranted(ask({ permission: "media", mediaTypes: ["audio"] }))).toBe(true);
  });

  test("never allows the camera, mixed media or an unknown media type", () => {
    expect(permissionGranted(ask({ permission: "media", mediaTypes: ["video"] }))).toBe(false);
    expect(permissionGranted(ask({ permission: "media", mediaTypes: ["audio", "video"] }))).toBe(
      false,
    );
    expect(permissionGranted(ask({ permission: "media", mediaTypes: ["unknown"] }))).toBe(false);
    expect(permissionGranted(ask({ permission: "media", mediaTypes: [] }))).toBe(false);
  });

  test("refuses everything from another origin or a window without a server", () => {
    expect(permissionGranted(ask({ requester: "https://evil.example" }))).toBe(false);
    expect(
      permissionGranted(
        ask({ permission: "media", mediaTypes: ["audio"], serverOrigin: null, requester: null }),
      ),
    ).toBe(false);
  });

  test("refuses other permissions such as geolocation", () => {
    expect(permissionGranted(ask({ permission: "geolocation" }))).toBe(false);
  });

  test("wantsMicrophone is true only for a granted audio request", () => {
    expect(wantsMicrophone(ask({ permission: "media", mediaTypes: ["audio"] }))).toBe(true);
    expect(wantsMicrophone(ask({}))).toBe(false);
  });
});
