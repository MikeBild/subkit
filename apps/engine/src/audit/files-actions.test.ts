// Audit action vocabulary test for the unified files resource.
//
// Pins the string values of every FILE_* action so a rename or a typo
// in types.ts produces a test failure rather than silent audit-log drift.

import { describe, expect, test } from "bun:test";

import { AuditAction, FILE_AUDIT_ACTIONS } from "./types.ts";

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

  test("FILE_LINK_REMOVED serialises to 'file.link_removed'", () => {
    expect(AuditAction.FILE_LINK_REMOVED).toBe("file.link_removed");
  });

  test("FILE_SCAN_COMPLETED serialises to 'file.scan_completed'", () => {
    expect(AuditAction.FILE_SCAN_COMPLETED).toBe("file.scan_completed");
  });

  test("FILE_UPLOAD_RECEIVED serialises to 'file.upload_received'", () => {
    expect(AuditAction.FILE_UPLOAD_RECEIVED).toBe("file.upload_received");
  });

  test("all nine FILE_* actions are present in AuditAction", () => {
    const fileActions = Object.entries(AuditAction)
      .filter(([, v]) => String(v).startsWith("file."))
      .map(([, v]) => v);

    // Set equality (not `toContain`) so the test fails when a NEW
    // FILE_* action lands without being declared here. Catches
    // vocabulary drift: a future `FILE_RESTORED` / `FILE_REHASHED`
    // addition forces the dev to extend this list, which forces a
    // review-pass on SIEM filters that scan on the FILE_* prefix.
    expect(new Set(fileActions)).toEqual(
      new Set([
        "file.created",
        "file.batch_created",
        "file.finalized",
        "file.downloaded",
        "file.deleted",
        "file.link_added",
        "file.link_removed",
        "file.scan_completed",
        "file.upload_received",
      ]),
    );
  });

  test("FILE_AUDIT_ACTIONS matches the file.* prefix membership", () => {
    // The declarative set should equal the prefix-derived set so a
    // future addition that updates one but not the other fails loudly.
    // Downstream SIEM / MCP filters import `FILE_AUDIT_ACTIONS` instead
    // of re-deriving the prefix grammar inline — this assertion keeps
    // the two views from drifting.
    const prefixMatched = new Set(
      Object.values(AuditAction).filter((v) => String(v).startsWith("file.")),
    );
    expect(new Set(FILE_AUDIT_ACTIONS)).toEqual(prefixMatched);
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
