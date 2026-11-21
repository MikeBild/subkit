import { describe, expect, test } from "bun:test";
import { aiAttentionReason } from "./ai-access-attention.ts";

const base = {
  selfService: false,
  local: true,
  configured: () => true,
  tools: async () => true as boolean | null,
};

describe("AI access attention", () => {
  test("a self-hosted server workspace is not asked", async () => {
    expect(await aiAttentionReason({ ...base, local: false, configured: () => false })).toBeNull();
  });

  test("a self-service or local workspace without AI access needs it", async () => {
    expect(
      await aiAttentionReason({
        ...base,
        local: false,
        selfService: true,
        configured: () => false,
      }),
    ).toBe("ai_access_missing");
    expect(await aiAttentionReason({ ...base, configured: () => false })).toBe("ai_access_missing");
  });

  test("a local model server without tool calls is named, an unchecked one is not", async () => {
    expect(await aiAttentionReason({ ...base, tools: async () => false })).toBe(
      "model_tools_missing",
    );
    expect(await aiAttentionReason({ ...base, tools: async () => null })).toBeNull();
    expect(await aiAttentionReason(base)).toBeNull();
    expect(
      await aiAttentionReason({
        ...base,
        local: false,
        selfService: true,
        tools: async () => false,
      }),
    ).toBeNull();
  });
});
