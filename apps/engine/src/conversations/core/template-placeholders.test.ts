import { describe, expect, test } from "bun:test";
import { extractTemplatePlaceholders } from "./template-placeholders.ts";

describe("connector template placeholders", () => {
  test("accepts optional templates and literal URLs without placeholders", () => {
    for (const value of [undefined, null, "", "https://example.test/path"])
      expect(extractTemplatePlaceholders(value)).toEqual([]);
  });

  test("preserves first appearance and deduplicates repeated configuration fields", () => {
    expect(
      extractTemplatePlaceholders("https://{host}/{version}?tenant={tenant}&again={host}"),
    ).toEqual(["host", "version", "tenant"]);
    expect(extractTemplatePlaceholders("{z}{a}{z}{A}")).toEqual(["z", "a", "A"]);
  });

  test("supports the complete connector field alphabet without normalizing names", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";
    expect(extractTemplatePlaceholders(`{${alphabet}}`)).toEqual([alphabet]);
    for (const character of alphabet)
      expect(extractTemplatePlaceholders(`before{${character}}after`)).toEqual([character]);
  });

  test("requires both braces, a nonempty name and excludes whitespace or URL punctuation", () => {
    for (const value of [
      "{}",
      "{name",
      "name}",
      "name",
      "{ }",
      "{a b}",
      "{a/b}",
      "{a:b}",
      "{a@b}",
      "{a\nb}",
      "{ä}",
    ])
      expect(extractTemplatePlaceholders(value)).toEqual([]);
    expect(extractTemplatePlaceholders("{{host}}/{ valid }/{valid}")).toEqual(["host", "valid"]);
  });
});
