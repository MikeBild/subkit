import { describe, expect, it } from "bun:test";
import { ERROR_META, loadingPhase } from "@ui/lib/errors";

describe("loading phase", () => {
  it("shows nothing for the first 150 ms", () => {
    expect(loadingPhase(100, 1500)).toBe("blank");
  });
  it("shows the skeleton after 150 ms while loading", () => {
    expect(loadingPhase(200, 1500)).toBe("skeleton");
  });
  it("keeps the skeleton at least 300 ms", () => {
    expect(loadingPhase(400, 200)).toBe("skeleton");
    expect(loadingPhase(450, 200)).toBe("ready");
  });
  it("never shows a skeleton for fast loads", () => {
    expect(loadingPhase(100, 100)).toBe("ready");
  });
});
describe("error catalog", () => {
  it("maps the skill version conflict to approval_mismatch", () => {
    expect(ERROR_META.skillConflict.cause).toBe("approval_mismatch");
  });
  it("maps a rejected API key to auth_failed", () => {
    expect(ERROR_META.keyRejected.code).toBe("auth_failed");
  });
});
