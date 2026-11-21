import { describe, expect, test } from "bun:test";
import { intakeMentionLabel } from "@/features/chat/api/mention-sources";

describe("intakeMentionLabel", () => {
  test("keeps a readable title in a token-safe form", () => {
    expect(intakeMentionLabel("Überprüfung: Q4 / Planung!")).toBe("Uberprufung-Q4-/-Planung");
  });

  test("uses a stable fallback only when a title has no mentionable characters", () => {
    expect(intakeMentionLabel("!!!")).toBe("Eintrag");
  });
});
