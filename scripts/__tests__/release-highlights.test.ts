import { describe, expect, test } from "bun:test";
import {
  bareVersion,
  completeHighlights,
  highlightsFromBody,
  highlightsFromReleases,
  parseHighlights,
  releaseBody,
  renderHighlights,
  splitHighlightsFlag,
  withoutHighlights,
} from "../lib/release-highlights.ts";

const body = [
  "# SubKit 12.1.0",
  "",
  "## Highlights (en)",
  "",
  "- New",
  "* Second  ",
  "",
  "## Highlights (de)",
  "",
  "- Neu",
  "",
  "## Changes",
  "",
  "- a commit subject",
].join("\n");

describe("release highlights", () => {
  test("reads only the bullets of a section", () => {
    expect(parseHighlights("Intro line.\n\n- First\n* Second  \n-   \n  - Third\n")).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  test("reads both marked sections of a release body and nothing after them", () => {
    expect(highlightsFromBody(body)).toEqual({ en: ["New", "Second"], de: ["Neu"] });
    expect(highlightsFromBody("## highlights (EN)\n- New\n")).toEqual({ en: ["New"] });
    expect(highlightsFromBody("- loose bullet\n## Changes\n- other")).toEqual({});
  });

  test("a version counts only with highlights in both languages", () => {
    expect(completeHighlights({ de: ["Neu"], en: ["New"] })).toEqual({ en: ["New"], de: ["Neu"] });
    expect(completeHighlights({ en: ["New"] })).toBeNull();
    expect(completeHighlights({ en: ["New"], de: [] })).toBeNull();
    expect(completeHighlights(undefined)).toBeNull();
    expect(bareVersion("v12.1.0")).toBe("12.1.0");
  });

  test("renders only the English section so that it reads back unchanged", () => {
    expect(renderHighlights(["New"])).toBe("## Highlights (en)\n\n- New\n");
    expect(highlightsFromBody(renderHighlights(["New"]))).toEqual({ en: ["New"] });
  });

  test("a release body puts the English highlights first and drops every older section", () => {
    expect(withoutHighlights(body)).toBe("# SubKit 12.1.0\n\n## Changes\n\n- a commit subject");
    expect(releaseBody(["Fresh"], body)).toBe(
      "## Highlights (en)\n\n- Fresh\n\n# SubKit 12.1.0\n\n## Changes\n\n- a commit subject\n",
    );
    expect(releaseBody(["New"], "")).toBe(renderHighlights(["New"]));
    expect(releaseBody(null, "- note\n")).toBe("- note\n");
    expect(releaseBody(["New"], body)).not.toContain("(de)");
  });

  test("takes only English highlights from published releases", () => {
    expect(
      highlightsFromReleases([
        { tag_name: "v12.1.0", body, draft: false },
        { tag_name: "v12.2.0", body, draft: true },
        { tag_name: "v12.0.0", body: "## Highlights (en)\n- Only English", draft: false },
        { tag_name: "v11.0.0", body: null, draft: false },
      ]),
    ).toEqual({ "12.1.0": { en: ["New", "Second"] }, "12.0.0": { en: ["Only English"] } });
  });

  test("splits the highlights file off the other arguments", () => {
    expect(splitHighlightsFlag(["--highlights", "/tmp/h.md", "--defer-mutation"])).toEqual({
      path: "/tmp/h.md",
      rest: ["--defer-mutation"],
      error: null,
    });
    expect(splitHighlightsFlag(["--highlights=/tmp/h.md"]).path).toBe("/tmp/h.md");
    expect(splitHighlightsFlag(["--model", "x"])).toEqual({
      path: null,
      rest: ["--model", "x"],
      error: null,
    });
    expect(splitHighlightsFlag(["--highlights"]).error).toBe("--highlights needs a file path");
  });
});
