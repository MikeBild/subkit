import { describe, expect, test } from "bun:test";
import { previewWarningDetail } from "./workflow-save-model.ts";

describe("previewWarningDetail", () => {
  test("preserves order and refuses non-string codes", () => {
    expect(previewWarningDetail([{ code: "first" }, { code: 2 }, {}, { code: "last" }])).toBe(
      "4 warning(s): first, last",
    );
    expect(previewWarningDetail([{}, { code: "" }])).toBe("2 warning(s): (no code)");
  });
});
