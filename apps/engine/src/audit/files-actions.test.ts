// Audit action vocabulary test for the unified files resource.
//
// Pins the string values of every FILE_* action so a rename or a typo
// in types.ts produces a test failure rather than silent audit-log drift.

import { describe, expect, test } from "bun:test";
import { AuditAction } from "./types.ts";

describe("FILE_* audit actions", () => {
  test("FILE_CREATED serialises to 'file.created'", () => {
    expect(AuditAction.FILE_CREATED).toBe("file.created");
  });

  test("FILE_BATCH_CREATED serialises to 'file.batch_created'", () => {
    expect(AuditAction.FILE_BATCH_CREATED).toBe("file.batch_created");
  });

  test("FILE_FINALIZED serialises to 'file.finalized'", () => {
    expect(AuditAction.FILE_FINALIZED).toBe("file.finalized");
  });

  test("FILE_DOWNLOADED serialises to 'file.downloaded'", () => {
    expect(AuditAction.FILE_DOWNLOADED).toBe("file.downloaded");
  });

  test("FILE_DELETED serialises to 'file.deleted'", () => {
    expect(AuditAction.FILE_DELETED).toBe("file.deleted");
  });

  test("FILE_LINK_ADDED serialises to 'file.link_added'", () => {
    expect(AuditAction.FILE_LINK_ADDED).toBe("file.link_added");
  });

  test("FILE_SCAN_COMPLETED serialises to 'file.scan_completed'", () => {
    expect(AuditAction.FILE_SCAN_COMPLETED).toBe("file.scan_completed");
  });

  test("all seven FILE_* actions are present in AuditAction", () => {
    const fileActions = Object.entries(AuditAction)
      .filter(([, v]) => String(v).startsWith("file."))
      .map(([, v]) => v);

    expect(fileActions).toContain("file.created");
    expect(fileActions).toContain("file.batch_created");
    expect(fileActions).toContain("file.finalized");
    expect(fileActions).toContain("file.downloaded");
    expect(fileActions).toContain("file.deleted");
    expect(fileActions).toContain("file.link_added");
    expect(fileActions).toContain("file.scan_completed");
  });

  test("AuditAction values are all strings (no accidental undefined)", () => {
    for (const [key, val] of Object.entries(AuditAction)) {
      expect(typeof val, `AuditAction.${key} should be a string`).toBe("string");
    }
  });

  test("no CONVERSATION_ATTACHMENT_* keys exist in AuditAction", () => {
    const legacyKeys = Object.keys(AuditAction).filter((k) =>
      k.startsWith("CONVERSATION_ATTACHMENT_"),
    );
    expect(legacyKeys).toHaveLength(0);
  });
});
