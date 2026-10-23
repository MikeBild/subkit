import { describe, expect, test } from "bun:test";
import { LlmGenerationAborted, LlmProviderError } from "../../errors.ts";
import { NO_REASON_GIVEN, parseGenerationAbort } from "../generation-abort.ts";
import { mapProviderError } from "../invoke.ts";

describe("structured generation abort", () => {
  test("keeps well-formed needs, normalises the method and drops malformed entries", () => {
    const abort = parseGenerationAbort({
      reason: "  route missing  ",
      needs: [
        { kind: "response_shape", connector_slug: "crm", method: "get", path: "/v2/deals" },
        { kind: "endpoint_contract", connector_slug: "", method: null, path: null, question: null },
        { kind: "free_text" },
        "not an object",
      ],
    });
    expect(abort).toEqual({
      reason: "route missing",
      needs: [
        {
          kind: "response_shape",
          connector_slug: "crm",
          method: "GET",
          path: "/v2/deals",
          question: null,
        },
        {
          kind: "endpoint_contract",
          connector_slug: null,
          method: null,
          path: null,
          question: null,
        },
      ],
    });
  });

  test("an abort without a reason or needs still yields a usable value", () => {
    expect(parseGenerationAbort(null)).toEqual({ reason: NO_REASON_GIVEN, needs: [] });
  });

  test("the invoke error mapping carries the needs through instead of flattening them", () => {
    const aborted = new LlmGenerationAborted({
      reason: "which mail connector",
      needs: [
        {
          kind: "connector_choice",
          connector_slug: "mail",
          method: null,
          path: null,
          question: "Which mail connector?",
        },
      ],
    });
    const mapped = mapProviderError(aborted);
    expect(mapped).toBe(aborted);
    expect(mapped).toBeInstanceOf(LlmProviderError);
    expect((mapped as LlmGenerationAborted).needs[0]?.kind).toBe("connector_choice");
    expect(mapProviderError(new Error("boom"))).not.toBeInstanceOf(LlmGenerationAborted);
  });
});
