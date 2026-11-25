import { describe, expect, test } from "bun:test";
import {
  classifyErrorCode,
  ERROR_CAUSES,
  ERROR_CODES,
  isErrorCode,
  PROVIDER_LIMITED,
  PROVIDER_QUOTA_EXHAUSTED,
  REMEDIES,
  REPAIR_REMEDIES,
  SPEND_LIMIT_REACHED,
} from "./error-taxonomy.ts";

describe("error taxonomy", () => {
  test("spend limit and provider quota are separate codes with separate remedies", () => {
    expect(SPEND_LIMIT_REACHED).not.toBe(PROVIDER_QUOTA_EXHAUSTED);
    expect(classifyErrorCode(SPEND_LIMIT_REACHED)).toEqual({
      cause: "budget_exhausted",
      remedy: "raise_spend_limit",
    });
    expect(classifyErrorCode(PROVIDER_QUOTA_EXHAUSTED)).toEqual({
      cause: "budget_exhausted",
      remedy: "provider_console",
    });
    expect(classifyErrorCode(PROVIDER_LIMITED)?.cause).toBe("rate_limited");
  });

  test("every code maps to a known cause and remedy", () => {
    for (const cls of Object.values(ERROR_CODES)) {
      expect(ERROR_CAUSES).toContain(cls.cause);
      if (cls.remedy !== null) expect(REMEDIES).toContain(cls.remedy);
    }
  });

  test("a local transform error is a step error, not an external-system error (#525)", () => {
    expect(classifyErrorCode("transform_error")).toEqual({ cause: "step_error", remedy: "patch" });
  });

  test("repair remedies are part of the remedy vocabulary", () => {
    for (const remedy of REPAIR_REMEDIES) expect(REMEDIES).toContain(remedy);
  });

  test("prefix families classify, unknown codes stay unclassified", () => {
    expect(classifyErrorCode("execution_authority_expired")?.cause).toBe("authority_mismatch");
    expect(classifyErrorCode("pagination_truncated")?.cause).toBe("incomplete_read");
    expect(classifyErrorCode("something_new")).toBeNull();
    expect(isErrorCode("something_new")).toBe(false);
    expect(isErrorCode("connector_not_found")).toBe(true);
  });
});
