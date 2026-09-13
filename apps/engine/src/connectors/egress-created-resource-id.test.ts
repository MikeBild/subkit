// `extractCreatedResourceId` is the generic, vendor-neutral id lifter
// for the `connector.invoked` audit row (both the call-connector path and
// the workflow-execution egress path use it). It must:
//   - only fire for WRITE methods (a read/delete creates nothing),
//   - pull the first id-like top-level field of the response body,
//   - never hardcode a vendor field, and
//   - survive the field-level secret scrubber intact (the load-bearing risk
//     flagged in project_redaction_corrupts_workflow_code).

import { describe, expect, test } from "bun:test";

import { scrubSecrets } from "../logging/scrub-secrets.ts";
import { extractCreatedResourceId } from "./egress.ts";

describe("extractCreatedResourceId — write-only, generic id lift", () => {
  test("POST/PUT/PATCH lift the first id-like field", () => {
    expect(extractCreatedResourceId("POST", { id: "19ef2f7843d2a14c" })).toBe("19ef2f7843d2a14c");
    expect(extractCreatedResourceId("PUT", { messageId: "abc-123" })).toBe("abc-123");
    expect(extractCreatedResourceId("PATCH", { message_id: "m_9" })).toBe("m_9");
    // Gmail send shape: { id, threadId } — id wins.
    expect(extractCreatedResourceId("POST", { id: "gmail-1", threadId: "t-1" })).toBe("gmail-1");
    // Numeric ids are stringified.
    expect(extractCreatedResourceId("POST", { id: 4242 })).toBe("4242");
    // Falls through to the next key when `id` is absent.
    expect(extractCreatedResourceId("POST", { name: "projects/42/resource" })).toBe(
      "projects/42/resource",
    );
  });

  test("reads and deletes create nothing", () => {
    expect(extractCreatedResourceId("GET", { id: "x" })).toBeUndefined();
    expect(extractCreatedResourceId("HEAD", { id: "x" })).toBeUndefined();
    expect(extractCreatedResourceId("DELETE", { id: "x" })).toBeUndefined();
    expect(extractCreatedResourceId("get", { id: "x" })).toBeUndefined(); // case-insensitive
  });

  test("ignores non-object / id-less / oversized bodies", () => {
    expect(extractCreatedResourceId("POST", null)).toBeUndefined();
    expect(extractCreatedResourceId("POST", "raw string")).toBeUndefined();
    expect(extractCreatedResourceId("POST", [{ id: "x" }])).toBeUndefined(); // arrays excluded
    expect(extractCreatedResourceId("POST", { status: "ok" })).toBeUndefined(); // no id-like key
    expect(extractCreatedResourceId("POST", { id: "a".repeat(300) })).toBeUndefined(); // too long
  });

  test("the lifted id survives the secret scrubber intact", () => {
    // A Gmail message id is 16 hex chars — exactly the shape a high-entropy
    // matcher could clobber. Assert it round-trips so the audit value is real.
    const id = extractCreatedResourceId("POST", { id: "19ef2f7843d2a14c" });
    expect(id).toBeDefined();
    expect(scrubSecrets(id as string)).toBe("19ef2f7843d2a14c");
  });
});
