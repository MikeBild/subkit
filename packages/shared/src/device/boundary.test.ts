import { describe, expect, test } from "bun:test";
import {
  appDigestMaterial,
  DEVICE_ALLOWANCE_KINDS,
  type DeviceAllowance,
  DeviceAllowanceSchema,
  type DeviceSubBoundary,
  DeviceSubBoundarySchema,
  rootDigestMaterial,
  siteDigestMaterial,
} from "./boundary.ts";

const D = "a".repeat(64);

describe("the device sub-boundary", () => {
  test("a minimal boundary round-trips and keeps absent fields absent", () => {
    const minimal: DeviceSubBoundary = { device_id: "dev-1", capability: "files" };
    const parsed = DeviceSubBoundarySchema.parse(minimal);
    expect(parsed).toEqual(minimal);
    expect(Object.keys(parsed)).toEqual(["device_id", "capability"]);
  });

  test("a workflow boundary with folders, sites and apps round-trips unchanged", () => {
    const full: DeviceSubBoundary = {
      device_id: "dev-1",
      capability: "browser",
      folders: [{ folder_id: "f1", access: "write", root_digest: D }],
      sites: [{ origin: "https://example.com", private: false, site_digest: D }],
      apps: [{ app_id: "com.apple.Numbers", app_digest: D }],
    };
    expect(DeviceSubBoundarySchema.parse(full)).toEqual(full);
  });

  test("rejects extra fields, null lists, commit modes and bad entries", () => {
    const base = { device_id: "dev-1", capability: "files" };
    expect(DeviceSubBoundarySchema.safeParse({ ...base, paths: [] }).success).toBe(false);
    for (const field of ["folders", "sites", "apps"]) {
      expect(DeviceSubBoundarySchema.safeParse({ ...base, [field]: null }).success).toBe(false);
    }
    expect(DeviceSubBoundarySchema.safeParse({ ...base, commits: "confirm_each" }).success).toBe(
      false,
    );
    expect(DeviceSubBoundarySchema.safeParse({ ...base, device_id: "" }).success).toBe(false);
    expect(DeviceSubBoundarySchema.safeParse({ ...base, capability: "shell" }).success).toBe(false);
    expect(
      DeviceSubBoundarySchema.safeParse({
        ...base,
        folders: [{ folder_id: "f", access: "write", root_digest: "A".repeat(64) }],
      }).success,
    ).toBe(false);
    expect(
      DeviceSubBoundarySchema.safeParse({
        ...base,
        folders: [{ folder_id: "f", access: "delete", root_digest: D }],
      }).success,
    ).toBe(false);
    expect(
      DeviceSubBoundarySchema.safeParse({
        ...base,
        sites: [{ origin: "https://a.example.com", private: false, site_digest: D, extra: 1 }],
      }).success,
    ).toBe(false);
    expect(
      DeviceSubBoundarySchema.safeParse({ ...base, apps: [{ app_id: "", app_digest: D }] }).success,
    ).toBe(false);
  });
});

describe("device allowances", () => {
  const allowances: DeviceAllowance[] = [
    {
      kind: "folder",
      id: "f1",
      display: "~/Documents/Rechnungen",
      access: "read",
      digest: D,
      entered_by: "person",
    },
    {
      kind: "site",
      id: "s1",
      origin: "http://192.168.1.10:8080",
      private: true,
      digest: D,
      entered_by: "person",
    },
    { kind: "app", id: "com.apple.Numbers", display: "Numbers", digest: D, entered_by: "approval" },
    { kind: "keep_out", id: "k1", target: "folder", display: "~/Private", entered_by: "person" },
  ];

  test("every kind round-trips unchanged", () => {
    for (const allowance of allowances) {
      expect(DeviceAllowanceSchema.parse(allowance)).toEqual(allowance);
    }
    expect(allowances.map((a) => a.kind)).toEqual([...DEVICE_ALLOWANCE_KINDS]);
  });

  test("only a person can add an off-limits entry", () => {
    expect(
      DeviceAllowanceSchema.safeParse({ ...allowances[3], entered_by: "approval" }).success,
    ).toBe(false);
  });

  test("unknown kinds and sources are rejected", () => {
    expect(DeviceAllowanceSchema.safeParse({ ...allowances[0], kind: "drive" }).success).toBe(
      false,
    );
    expect(DeviceAllowanceSchema.safeParse({ ...allowances[1], entered_by: "page" }).success).toBe(
      false,
    );
  });
});

describe("digest material", () => {
  test("is canonical and separates every input", () => {
    const root = rootDigestMaterial({
      device_id: "d",
      real_path: "/Users/mike/Docs",
      volume_id: "v",
      file_id: "42",
    });
    expect(root).toBe('["root","d","/Users/mike/Docs","v","42"]');
    expect(
      rootDigestMaterial({
        device_id: "d",
        real_path: "/Users/mike/Docs",
        volume_id: "v",
        file_id: "43",
      }),
    ).not.toBe(root);
    expect(
      siteDigestMaterial({ device_id: "d", origin: "https://a.example", private: false }),
    ).toBe('["site","d","https://a.example",false]');
    expect(
      appDigestMaterial({ device_id: "d", bundle_id: "com.apple.Numbers", team_id: null }),
    ).toBe('["app","d","com.apple.Numbers",null]');
  });
});
