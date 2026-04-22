// Pure-render tests for renderAuthoringContextBlock — no DB.

import { describe, expect, it } from "bun:test";
import { renderAuthoringContextBlock } from "../authoring-context-block.ts";

describe("renderAuthoringContextBlock — Document Analysis section", () => {
  it("emits the section when endpoint_count > 0", () => {
    const out = renderAuthoringContextBlock({
      draft: null,
      document_analysis: {
        source: "openapi",
        confidence: 92,
        endpoint_count: 6,
        sample_endpoints: [
          { method: "GET", path: "/v1/charges" },
          { method: "POST", path: "/v1/charges" },
        ],
      },
      user_message: "I uploaded a spec",
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("## Document Analysis");
    expect(out!).toContain("source=openapi");
    expect(out!).toContain("confidence=92%");
    expect(out!).toContain("endpoints=6");
    expect(out!).toContain("GET /v1/charges");
    expect(out!).toContain("POST /v1/charges");
  });

  it("omits the section when endpoint_count is 0", () => {
    const out = renderAuthoringContextBlock({
      draft: null,
      document_analysis: { source: "openapi", confidence: 0, endpoint_count: 0 },
      user_message: "anything",
    });
    expect(out ?? "").not.toContain("## Document Analysis");
  });

  it("omits the section when document_analysis is null", () => {
    const out = renderAuthoringContextBlock({
      draft: null,
      document_analysis: null,
      user_message: "anything",
    });
    expect(out ?? "").not.toContain("## Document Analysis");
  });

  it("renders no tone hint when expertise is omitted", () => {
    const out = renderAuthoringContextBlock({ draft: null, user_message: "hi" });
    expect(out ?? "").not.toContain("Tone hint");
  });

  it("renders the expertise tone hint when expertise is set", () => {
    const novice = renderAuthoringContextBlock({
      draft: null,
      user_message: "how do I start?",
      expertise: "novice",
    });
    expect(novice!).toContain("## Tone hint (novice)");
    expect(novice!).toContain("step-by-step");

    const expert = renderAuthoringContextBlock({
      draft: null,
      user_message: "diff only please",
      expertise: "expert",
    });
    expect(expert!).toContain("## Tone hint (expert)");
    expect(expert!).toContain("dense diffs");
  });

  it("renders only the first 6 endpoints with overflow note", () => {
    const sample = Array.from({ length: 10 }, (_, i) => ({
      method: "GET",
      path: `/v1/items/${i}`,
    }));
    const out = renderAuthoringContextBlock({
      draft: null,
      document_analysis: {
        source: "har",
        confidence: 98,
        endpoint_count: 10,
        sample_endpoints: sample,
      },
      user_message: "x",
    });
    expect(out!).toContain("/v1/items/0");
    expect(out!).toContain("/v1/items/5");
    expect(out!).not.toContain("/v1/items/6");
    expect(out!).toContain("…and 4 more");
  });
});
