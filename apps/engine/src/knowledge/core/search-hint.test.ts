import { describe, expect, test } from "bun:test";
import { availableTags, emptySearchHint, type HintSource } from "./search-hint.ts";

function source(overrides: Partial<HintSource> = {}): HintSource {
  return { status: "active", scope: "global", workflow_id: null, tags: [], ...overrides };
}

describe("availableTags", () => {
  test("ranks tags of active sources by use, then alphabetically, ignoring case", () => {
    const tags = availableTags(
      [
        source({ tags: ["billing", "Shipping"] }),
        source({ tags: ["shipping", "returns", "shipping"] }),
        source({ tags: ["archive"], status: "inactive" }),
      ],
      null,
    );
    expect(tags).toEqual(["Shipping", "billing", "returns"]);
  });

  test("includes workflow sources only for the current workflow", () => {
    const sources = [
      source({ scope: "workflow", workflow_id: "w1", tags: ["w1-only"] }),
      source({ tags: ["global"] }),
    ];
    expect(availableTags(sources, null)).toEqual(["global"]);
    expect(availableTags(sources, "w1")).toEqual(["global", "w1-only"]);
  });

  test("caps the list", () => {
    expect(availableTags([source({ tags: ["a", "b", "c"] })], null, 2)).toEqual(["a", "b"]);
  });
});

describe("emptySearchHint", () => {
  test("names the available tags", () => {
    expect(emptySearchHint(["billing", "shipping"])).toContain(
      "Available tags: billing, shipping.",
    );
  });

  test("says when no source has tags", () => {
    expect(emptySearchHint([])).toContain("no knowledge source has tags yet");
  });

  test("points out requested tags nobody uses", () => {
    expect(emptySearchHint(["billing"], ["Billing", "legal"])).toContain(
      "No source carries the tag legal.",
    );
  });
});
