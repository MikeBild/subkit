import { describe, expect, test } from "bun:test";
import { DEVICE_REFUSALS } from "@shared/device/protocol.ts";
import { type FilesSnapshot, folderDigest } from "./files-allowances.ts";
import {
  FAILURE_DETAILS,
  failed,
  failureOfError,
  grantTarget,
  modeOf,
  needsSegment,
  REFUSAL_DETAILS,
  refused,
  requiredAccess,
  targetFitsMode,
} from "./files-policy.ts";

const folder = {
  id: "docs",
  path: "/Users/mike/Docs",
  display: "~/Docs",
  access: "read" as const,
  volume_id: "1",
  file_id: "2",
};
const snapshot: FilesSnapshot = {
  personal_enabled: true,
  home: "/Users/mike",
  data_dir: "/Users/mike/Library/Application Support/SubKit",
  folders: [folder],
  keep_out: [],
};
const boundary = (access: "read" | "write", digest = folderDigest("d1", folder)) => ({
  device_id: "d1",
  capability: "files" as const,
  folders: [{ folder_id: "docs", access, root_digest: digest }],
});
const target = { folder_id: "docs", path: "a.txt" };

describe("files policy", () => {
  test("workflows use folder lists, everything else the personal mode", () => {
    expect(modeOf({ execution_id: "e1" })).toBe("workflow");
    expect(modeOf({ execution_id: null })).toBe("personal");
    expect(targetFitsMode(target, "workflow")).toBe(true);
    expect(targetFitsMode(target, "personal")).toBe(false);
    expect(targetFitsMode({ absolute: "/x" }, "personal")).toBe(true);
    expect(targetFitsMode({ absolute: "/x" }, "workflow")).toBe(false);
  });

  test("reads need read access, every change needs write access", () => {
    expect(requiredAccess("files.list")).toBe("read");
    expect(requiredAccess("files.read_text")).toBe("read");
    expect(requiredAccess("files.import")).toBe("read");
    for (const kind of ["files.write", "files.mkdir", "files.move", "files.trash"] as const) {
      expect(requiredAccess(kind)).toBe("write");
    }
  });

  test.each([
    ["granted", { boundary: boundary("read") }, { ok: true, folder }],
    [
      "personal switch off does not matter for workflows",
      { snapshot: { ...snapshot, personal_enabled: false }, boundary: boundary("read") },
      { ok: true, folder },
    ],
    ["no boundary", { boundary: undefined }, { ok: false, code: "outside_boundary" }],
    [
      "other device",
      { boundary: { ...boundary("read"), device_id: "d2" } },
      { ok: false, code: "outside_boundary" },
    ],
    [
      "other capability",
      { boundary: { ...boundary("read"), capability: "browser" as const } },
      { ok: false, code: "outside_boundary" },
    ],
    [
      "boundary reads, step writes",
      { need: "write" as const, boundary: boundary("read") },
      { ok: false, code: "outside_boundary" },
    ],
    [
      "device reads, step writes",
      { need: "write" as const, boundary: boundary("write") },
      { ok: false, code: "outside_allowance" },
    ],
    [
      "unknown folder",
      {
        target: { folder_id: "x", path: "" },
        boundary: {
          ...boundary("read"),
          folders: [{ folder_id: "x", access: "read" as const, root_digest: "a".repeat(64) }],
        },
      },
      { ok: false, code: "outside_allowance" },
    ],
    [
      "digest differs",
      { boundary: boundary("read", "b".repeat(64)) },
      { ok: false, code: "folder_changed" },
    ],
    [
      "absolute target",
      { target: { absolute: "/Users/mike/Docs/a.txt" } },
      { ok: false, code: "outside_boundary" },
    ],
  ])("%s", (_name, override, expected) => {
    expect(
      grantTarget({
        mode: "workflow",
        device_id: "d1",
        snapshot,
        boundary: boundary("read"),
        target,
        need: "read",
        ...override,
      }),
    ).toEqual(expected as never);
  });

  test("personal mode is refused while its switch is off", () => {
    expect(
      grantTarget({
        mode: "personal",
        device_id: "d1",
        snapshot: { ...snapshot, personal_enabled: false },
        boundary: undefined,
        need: "read",
        target: { absolute: "/Users/mike/a.txt" },
      }),
    ).toEqual({ ok: false, code: "outside_allowance" });
  });

  test("personal mode needs only the switch and an absolute target", () => {
    const base = {
      mode: "personal" as const,
      device_id: "d1",
      snapshot,
      boundary: undefined,
      need: "write" as const,
    };
    expect(grantTarget({ ...base, target: { absolute: "/Users/mike/a.txt" } })).toEqual({
      ok: true,
      folder: null,
    });
    expect(grantTarget({ ...base, target })).toEqual({ ok: false, code: "outside_boundary" });
  });

  test("changes need at least one path segment", () => {
    expect(needsSegment(0, "files.list").ok).toBe(true);
    expect(needsSegment(0, "files.trash")).toEqual({ ok: false, code: "outside_allowance" });
    expect(needsSegment(1, "files.write").ok).toBe(true);
  });

  test("every refusal and failure has a detail", () => {
    for (const code of DEVICE_REFUSALS)
      expect(refused(code)).toEqual({ status: "refused", code, detail: REFUSAL_DETAILS[code] });
    for (const code of Object.keys(FAILURE_DETAILS) as (keyof typeof FAILURE_DETAILS)[]) {
      expect(failed(code)).toMatchObject({ status: "failed", code });
    }
  });

  test.each([
    ["ENOENT", "not_found"],
    ["EEXIST", "target_exists"],
    ["ENOTEMPTY", "target_exists"],
    ["ENOTDIR", "not_a_folder"],
    ["EISDIR", "not_a_file"],
    ["EXDEV", "cross_volume"],
    ["EACCES", "io_error"],
  ])("maps %s to %s", (code, expected) => {
    expect(failureOfError({ code })).toBe(expected as never);
  });

  test("maps an unknown error to io_error", () => {
    expect(failureOfError(null)).toBe("io_error");
  });
});
