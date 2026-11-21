import { describe, expect, test } from "bun:test";
import {
  allowancesDigestMaterial,
  FILES_BATCH_MAX,
  FilesMoveArgsSchema,
  FilesWriteArgsSchema,
  FileTargetSchema,
} from "./files.ts";

describe("file command arguments", () => {
  test("a target is either a folder and relative path or an absolute path", () => {
    expect(FileTargetSchema.safeParse({ folder_id: "f1", path: "a.txt" }).success).toBe(true);
    expect(FileTargetSchema.safeParse({ absolute: "/Users/me/a.txt" }).success).toBe(true);
    expect(FileTargetSchema.safeParse({ folder_id: "f1", path: "a", absolute: "/x" }).success).toBe(
      false,
    );
  });

  test("a write never replaces unless it says so", () => {
    const parsed = FilesWriteArgsSchema.parse({
      target: { folder_id: "f1", path: "a.txt" },
      content: { encoding: "utf8", text: "x" },
    });
    expect(parsed.replace).toBe(false);
  });

  test("a batch holds at most 200 items", () => {
    const item = { from: { absolute: "/a" }, to: { absolute: "/b" } };
    expect(
      FilesMoveArgsSchema.safeParse({ items: Array(FILES_BATCH_MAX).fill(item) }).success,
    ).toBe(true);
    expect(
      FilesMoveArgsSchema.safeParse({ items: Array(FILES_BATCH_MAX + 1).fill(item) }).success,
    ).toBe(false);
  });

  test("the allowances digest material ignores list and key order", () => {
    const a = { kind: "folder", id: "2", display: "~/B", access: "read" };
    const b = { kind: "folder", id: "1", display: "~/A", access: "write" };
    const reordered = { access: "read", display: "~/B", id: "2", kind: "folder" };
    expect(allowancesDigestMaterial([a, b])).toBe(allowancesDigestMaterial([b, reordered]));
    expect(allowancesDigestMaterial([a])).not.toBe(allowancesDigestMaterial([b]));
  });
});
