import { describe, expect, test } from "bun:test";
import {
  ChatEventJobSchema,
  ChatInteractionEnvelopeSchema,
  ChatViewMetadataSchema,
  validateElicitationOutput,
} from "../api.ts";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";

describe("ChatInteractionEnvelopeSchema", () => {
  test("accepts a well-formed envelope", () => {
    const r = ChatInteractionEnvelopeSchema.safeParse({
      c: UUID,
      o: { confirmed: true },
    });
    expect(r.success).toBe(true);
  });

  test("rejects a non-UUID conversation_id", () => {
    const r = ChatInteractionEnvelopeSchema.safeParse({ c: "not-a-uuid", o: {} });
    expect(r.success).toBe(false);
  });

  test("rejects a missing c", () => {
    const r = ChatInteractionEnvelopeSchema.safeParse({ o: {} });
    expect(r.success).toBe(false);
  });

  test("allows o to be absent", () => {
    const r = ChatInteractionEnvelopeSchema.safeParse({ c: UUID });
    expect(r.success).toBe(true);
  });
});

describe("ChatViewMetadataSchema", () => {
  test("accepts a well-formed metadata", () => {
    const r = ChatViewMetadataSchema.safeParse({ c: UUID, e: UUID_2, k: "form" });
    expect(r.success).toBe(true);
  });

  test("rejects an unknown kind", () => {
    const r = ChatViewMetadataSchema.safeParse({ c: UUID, e: UUID_2, k: "yolo" });
    expect(r.success).toBe(false);
  });

  test("rejects a non-UUID elicitation_id", () => {
    const r = ChatViewMetadataSchema.safeParse({ c: UUID, e: "not-a-uuid", k: "text" });
    expect(r.success).toBe(false);
  });
});

describe("ChatEventJobSchema", () => {
  test("accepts a well-formed mention job", () => {
    const r = ChatEventJobSchema.safeParse({
      event: {
        platform: "slack",
        workspace_id: "T_HANDLER",
        channel_id: "C1",
        user_id: "U1",
        kind: "mention",
        text: "hi",
        raw: {},
      },
    });
    expect(r.success).toBe(true);
  });

  test("rejects an event with an empty workspace_id", () => {
    const r = ChatEventJobSchema.safeParse({
      event: {
        platform: "slack",
        workspace_id: "",
        channel_id: "C1",
        user_id: "U1",
        kind: "mention",
        raw: {},
      },
    });
    expect(r.success).toBe(false);
  });

  test("rejects an unknown platform", () => {
    const r = ChatEventJobSchema.safeParse({
      event: {
        platform: "discord",
        workspace_id: "X",
        channel_id: "C1",
        user_id: "U1",
        kind: "mention",
        raw: {},
      },
    });
    expect(r.success).toBe(false);
  });
});

describe("validateElicitationOutput", () => {
  test("confirm: requires boolean confirmed", () => {
    expect(validateElicitationOutput("confirm", { confirmed: true })).toEqual({ confirmed: true });
    expect(validateElicitationOutput("confirm", {})).toBeNull();
    expect(validateElicitationOutput("confirm", { confirmed: "yes" })).toBeNull();
  });

  test("choice: requires non-empty string value", () => {
    expect(validateElicitationOutput("choice", { value: "a" })).toEqual({ value: "a" });
    expect(validateElicitationOutput("choice", { value: "" })).toBeNull();
    expect(validateElicitationOutput("choice", { value: 42 })).toBeNull();
  });

  test("multi: requires values to be a string array", () => {
    expect(validateElicitationOutput("multi", { values: ["a", "b"] })).toEqual({
      values: ["a", "b"],
    });
    expect(validateElicitationOutput("multi", { values: [1, 2] })).toBeNull();
  });

  test("text: requires text string", () => {
    expect(validateElicitationOutput("text", { text: "hi" })).toEqual({ text: "hi" });
    expect(validateElicitationOutput("text", { text: 0 })).toBeNull();
  });

  test("form: accepts a dict of primitives (incl. null for cleared fields)", () => {
    const ok = validateElicitationOutput("form", {
      name: "alice",
      age: 30,
      active: true,
      bio: null,
      tags: ["a", "b"],
    });
    expect(ok).toEqual({ name: "alice", age: 30, active: true, bio: null, tags: ["a", "b"] });
  });

  test("form: rejects nested objects", () => {
    const bad = validateElicitationOutput("form", { config: { nested: "yes" } });
    expect(bad).toBeNull();
  });
});
