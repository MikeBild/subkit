import { describe, expect, test } from "bun:test";

import { storedAuthoringMode } from "./chat-permission";

describe("stored authoring mode", () => {
  test("never labels missing or unrecognised old data as automatic", () => {
    for (const draft of [
      null,
      undefined,
      {},
      { session: {} },
      { session: { permission_mode: "future" } },
    ]) {
      expect(storedAuthoringMode(draft)).toBe("legacy");
    }
  });
  test("displays the stored mode after reload", () => {
    for (const mode of ["auto", "ask", "plan", "yolo"] as const) {
      expect(storedAuthoringMode({ session: { permission_mode: mode } })).toBe(mode);
    }
  });
});
