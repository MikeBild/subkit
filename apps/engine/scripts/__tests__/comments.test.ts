import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { findComments } from "../audit/comments.ts";

describe("findComments", () => {
  test.each([
    "../../src/http/routes/ai/extract.ts",
    "../../../subkit/src/engine-client/knowledge.ts",
  ])("filename encoding satisfies the no-comments invariant: %s (#558)", (file) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(findComments(file, source)).toEqual([]);
  });

  test("Markdown byte truncation satisfies the no-comments invariant (#543)", () => {
    const source = readFileSync(
      new URL("../../src/execution/result-markdown.ts", import.meta.url),
      "utf8",
    );
    expect(findComments("result-markdown.ts", source)).toEqual([]);
  });

  test("setup pair visibility satisfies the no-comments invariant (#552)", () => {
    const source = readFileSync(
      new URL("../../../cockpit/src/features/operations/pair-model.ts", import.meta.url),
      "utf8",
    );
    expect(findComments("pair-model.ts", source)).toEqual([]);
  });

  test("reports line, block and JSX comments", () => {
    const source = [
      "// a",
      "const x = 1; /* b */",
      "export const C = () => <div>{/* c */}</div>;",
    ].join("\n");
    expect(findComments("a.tsx", source).map((hit) => hit.line)).toEqual([1, 2, 3]);
  });

  test("keeps tool directives and the reason lines that continue them", () => {
    const source = [
      "// biome-ignore lint/style/noNonNullAssertion: checked above",
      "const a = b!;",
      "// tenant-filter:exempt — pre-tenant lookup",
      "// on the platform id",
      "db.select();",
    ].join("\n");
    expect(findComments("a.ts", source)).toEqual([]);
  });

  test("ignores comment markers inside strings, templates, regexes and JSX text", () => {
    const source = [
      'const s = "// not a comment";',
      "const t = `/* not ${s} either */`;",
      "const r = /a\\/\\/b/;",
      "export const C = () => <p>// text</p>;",
    ].join("\n");
    expect(findComments("a.tsx", source)).toEqual([]);
  });

  test("recognizes real Stryker directives while reporting ordinary Stryker commentary", () => {
    expect(
      findComments(
        "a.ts",
        "try { JSON.parse(body); } catch /* Stryker disable next-line BlockStatement: reviewed equivalent */ { return null; }",
      ),
    ).toEqual([]);
    expect(findComments("a.ts", "// Stryker is useful\nconst a = 1;")).toHaveLength(1);
  });
});
