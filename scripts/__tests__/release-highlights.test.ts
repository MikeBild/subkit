import { describe, expect, test } from "bun:test";
import {
  bareVersion,
  completeHighlights,
  highlightsFromBody,
  highlightsFromReleases,
  missingHighlightLanguages,
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
    expect(missingHighlightLanguages({ de: ["Neu"] })).toEqual(["en"]);
    expect(missingHighlightLanguages({})).toEqual(["en", "de"]);
    expect(bareVersion("v12.1.0")).toBe("12.1.0");
  });

  test("renders the sections so that they read back unchanged", () => {
    const highlights = { en: ["New"], de: ["Neu"] };
    expect(renderHighlights(highlights)).toBe(
      "## Highlights (en)\n\n- New\n\n## Highlights (de)\n\n- Neu\n",
    );
    expect(highlightsFromBody(renderHighlights(highlights))).toEqual(highlights);
  });

  test("a release body puts the highlights first and replaces older ones", () => {
    expect(withoutHighlights(body)).toBe("# SubKit 12.1.0\n\n## Changes\n\n- a commit subject");
    expect(releaseBody({ en: ["Fresh"], de: ["Frisch"] }, body)).toBe(
      "## Highlights (en)\n\n- Fresh\n\n## Highlights (de)\n\n- Frisch\n\n# SubKit 12.1.0\n\n## Changes\n\n- a commit subject\n",
    );
    expect(releaseBody({ en: ["New"], de: ["Neu"] }, "")).toBe(
      renderHighlights({ en: ["New"], de: ["Neu"] }),
    );
    expect(releaseBody(null, "- note\n")).toBe("- note\n");
  });

  test("takes highlights only from published releases with both languages", () => {
    expect(
      highlightsFromReleases([
        { tag_name: "v12.1.0", body, draft: false },
        { tag_name: "v12.2.0", body, draft: true },
        { tag_name: "v12.0.0", body: "## Highlights (en)\n- Only English", draft: false },
        { tag_name: "v11.0.0", body: null, draft: false },
      ]),
    ).toEqual({ "12.1.0": { en: ["New", "Second"], de: ["Neu"] } });
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
