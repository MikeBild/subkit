import { describe, expect, test } from "bun:test";
import {
  bareVersion,
  highlightsFromBody,
  highlightsFromReleases,
  otherHighlightsHeading,
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
  "- another language",
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

  test("reads only the English section of a release body and nothing after it", () => {
    expect(highlightsFromBody(body)).toEqual(["New", "Second"]);
    expect(highlightsFromBody("## highlights (EN)\n- New\n")).toEqual(["New"]);
    expect(highlightsFromBody("- loose bullet\n## Changes\n- other")).toEqual([]);
    expect(bareVersion("v12.1.0")).toBe("12.1.0");
  });

  test("names a highlights section in any other language", () => {
    expect(otherHighlightsHeading(body)).toBe("## Highlights (de)");
    expect(otherHighlightsHeading(renderHighlights(["New"]))).toBeNull();
  });

  test("renders the English section so that it reads back unchanged", () => {
    expect(renderHighlights(["New"])).toBe("## Highlights (en)\n\n- New\n");
    expect(highlightsFromBody(renderHighlights(["New"]))).toEqual(["New"]);
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
    ).toEqual({ "12.1.0": ["New", "Second"], "12.0.0": ["Only English"] });
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
