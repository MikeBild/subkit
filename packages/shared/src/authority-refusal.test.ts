import { describe, expect, test } from "bun:test";
import {
  AUTHORITY_REFUSAL_CODES,
  backfilledHoldReason,
  isAuthorityRefusalCode,
} from "./authority-refusal.ts";

describe("the reasons an approval cannot carry a run", () => {
  test("are exactly five, each with the approval prefix", () => {
    expect([...AUTHORITY_REFUSAL_CODES].sort()).toEqual([
      "execution_authority_changed",
      "execution_authority_exhausted",
      "execution_authority_expired",
      "execution_authority_required",
      "execution_authority_revoked",
    ]);
  });

  test("only those five are recognised", () => {
    for (const code of AUTHORITY_REFUSAL_CODES) expect(isAuthorityRefusalCode(code)).toBe(true);
    expect(isAuthorityRefusalCode("execution_authority_unavailable")).toBe(false);
    expect(isAuthorityRefusalCode("input_required")).toBe(false);
    expect(isAuthorityRefusalCode(null)).toBe(false);
    expect(isAuthorityRefusalCode(undefined)).toBe(false);
  });
});

describe("persisted holds move off the removed reason", () => {
  test("the removed reason becomes expired, everything else stays", () => {
    expect(backfilledHoldReason("execution_authority_unavailable")).toBe(
      "execution_authority_expired",
    );
    expect(backfilledHoldReason("execution_authority_required")).toBe(
      "execution_authority_required",
    );
    expect(backfilledHoldReason("input_required")).toBe("input_required");
  });
});
