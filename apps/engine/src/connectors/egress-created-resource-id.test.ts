import { describe, expect, test } from "bun:test";
import { scrubSecrets } from "../logging/scrub-secrets.ts";
import { extractCreatedResourceId } from "./egress.ts";

describe("extractCreatedResourceId — write-only, generic id lift", () => {
  test("POST/PUT/PATCH lift the first id-like field", () => {
    expect(extractCreatedResourceId("POST", { id: "19ef2f7843d2a14c" })).toBe("19ef2f7843d2a14c");
    expect(extractCreatedResourceId("PUT", { messageId: "abc-123" })).toBe("abc-123");
    expect(extractCreatedResourceId("PATCH", { message_id: "m_9" })).toBe("m_9");
    expect(extractCreatedResourceId("POST", { id: "gmail-1", threadId: "t-1" })).toBe("gmail-1");
    expect(extractCreatedResourceId("POST", { id: 4242 })).toBe("4242");
    expect(extractCreatedResourceId("POST", { name: "projects/42/resource" })).toBe(
      "projects/42/resource",
    );
  });

  test("reads and deletes create nothing", () => {
    expect(extractCreatedResourceId("GET", { id: "x" })).toBeUndefined();
    expect(extractCreatedResourceId("HEAD", { id: "x" })).toBeUndefined();
    expect(extractCreatedResourceId("DELETE", { id: "x" })).toBeUndefined();
    expect(extractCreatedResourceId("get", { id: "x" })).toBeUndefined();
  });

  test("ignores non-object / id-less / oversized bodies", () => {
    expect(extractCreatedResourceId("POST", null)).toBeUndefined();
    expect(extractCreatedResourceId("POST", "raw string")).toBeUndefined();
    expect(extractCreatedResourceId("POST", [{ id: "x" }])).toBeUndefined();
    expect(extractCreatedResourceId("POST", { status: "ok" })).toBeUndefined();
    expect(extractCreatedResourceId("POST", { id: "a".repeat(300) })).toBeUndefined();
  });

  test("the lifted id survives the secret scrubber intact", () => {
    const id = extractCreatedResourceId("POST", { id: "19ef2f7843d2a14c" });
    expect(id).toBeDefined();
    expect(scrubSecrets(id as string)).toBe("19ef2f7843d2a14c");
  });
});
