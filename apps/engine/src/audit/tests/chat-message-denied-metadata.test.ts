import { describe, expect, test } from "bun:test";
import { ChatMessageDeniedMetadataSchema } from "../types.ts";

describe("ChatMessageDeniedMetadataSchema", () => {
  test("accepts the legacy shape (no sender / display name)", () => {
    const parsed = ChatMessageDeniedMetadataSchema.parse({
      platform: "slack",
      workspace_id_native: "T123",
      event_key: null,
      kind: "mention",
    });
    expect(parsed.sender_platform_user_id).toBeUndefined();
    expect(parsed.space_display_name).toBeUndefined();
  });

  test("round-trips the enriched shape the pending query reads", () => {
    const parsed = ChatMessageDeniedMetadataSchema.parse({
      platform: "google_chat",
      workspace_id_native: "spaces/X",
      event_key: null,
      kind: "mention",
      sender_platform_user_id: "users/g-1",
      space_display_name: "Team X",
    });
    expect(parsed.sender_platform_user_id).toBe("users/g-1");
    expect(parsed.space_display_name).toBe("Team X");
  });

  test("accepts a null sender (workspace-scoped platform write-guard)", () => {
    const parsed = ChatMessageDeniedMetadataSchema.parse({
      platform: "slack",
      workspace_id_native: "T456",
      event_key: "evt-1",
      kind: "slash_command",
      sender_platform_user_id: null,
      space_display_name: null,
    });
    expect(parsed.sender_platform_user_id).toBeNull();
  });
});
