// Pure unit tests for `output-format.ts`.
//
// Both helpers are fully deterministic — no I/O, no LLM, no DB.
// Tests run in `bun run test:unit` without any external dependencies.

import { describe, expect, test } from "bun:test";
import {
  detectNamedOutputFormat,
  formatGuidance,
  type NamedOutputFormat,
  outputMatchesFormat,
} from "../output-format.ts";

describe("detectNamedOutputFormat", () => {
  test('"...return a markdown table that ranks..." → "markdown_table"', () => {
    expect(detectNamedOutputFormat("return a markdown table that ranks the top 10 cities")).toBe(
      "markdown_table",
    );
  });

  test('"export as CSV" → "csv"', () => {
    expect(detectNamedOutputFormat("export as CSV")).toBe("csv");
  });

  test('"an HTML email body" → "html"', () => {
    expect(detectNamedOutputFormat("an HTML email body with the monthly summary")).toBe("html");
  });

  test('"a bulleted list of..." → "bulleted_list"', () => {
    expect(detectNamedOutputFormat("give me a bulleted list of the top recommendations")).toBe(
      "bulleted_list",
    );
  });

  test("plain-data goal names no format → null", () => {
    expect(detectNamedOutputFormat("email me the droplet specs")).toBeNull();
  });

  test("case-insensitive: MARKDOWN TABLE matches", () => {
    expect(detectNamedOutputFormat("Return a MARKDOWN TABLE with all droplets")).toBe(
      "markdown_table",
    );
  });

  test("case-insensitive: CSV in mixed case matches", () => {
    expect(detectNamedOutputFormat("Download it as csv format")).toBe("csv");
  });

  test("case-insensitive: Html matches", () => {
    expect(detectNamedOutputFormat("produce an Html report")).toBe("html");
  });

  test('"bullet-point list" variant matches "bulleted_list"', () => {
    expect(detectNamedOutputFormat("show a bullet-point list of the findings")).toBe(
      "bulleted_list",
    );
  });

  test('"bullet points" variant matches "bulleted_list"', () => {
    expect(detectNamedOutputFormat("return bullet points for each item")).toBe("bulleted_list");
  });

  test("md table shorthand matches", () => {
    expect(detectNamedOutputFormat("produce an md table of results")).toBe("markdown_table");
  });
});

describe("outputMatchesFormat — markdown_table", () => {
  test("JSON-array string → ok:false with TWO missing entries (row + separator)", () => {
    const result = outputMatchesFormat("markdown_table", JSON.stringify([{ city: "Berlin" }]));
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(2);
  });

  test("real markdown table → ok:true, missing:[]", () => {
    const md = "| rank | city |\n| ---: | --- |\n| 1 | Berlin |";
    const result = outputMatchesFormat("markdown_table", md);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("table rows present but NO separator → ok:false, separator in missing only", () => {
    // Has pipe-delimited rows but no `| --- |` separator.
    const rowsOnly = "| rank | city |\n| 1 | Berlin |";
    const result = outputMatchesFormat("markdown_table", rowsOnly);
    expect(result.ok).toBe(false);
    // Only the separator is missing — the row check passes.
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toContain("separator");
  });

  test("empty string → ok:false with both entries missing", () => {
    const result = outputMatchesFormat("markdown_table", "");
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(2);
  });
});

describe("outputMatchesFormat — csv", () => {
  test("comma-separated rows → ok:true", () => {
    const result = outputMatchesFormat("csv", "name,age\nAlice,30\nBob,25");
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("plain prose with no commas → ok:false", () => {
    const result = outputMatchesFormat("csv", "here is some plain text without commas");
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toContain("CSV");
  });
});

describe("outputMatchesFormat — html", () => {
  test("string with HTML tags → ok:true", () => {
    const result = outputMatchesFormat("html", "<p>Hello <strong>world</strong></p>");
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("plain text without any tags → ok:false", () => {
    const result = outputMatchesFormat("html", "plain text no tags here");
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toContain("HTML");
  });
});

describe("outputMatchesFormat — bulleted_list", () => {
  test("dash-prefixed list lines → ok:true", () => {
    const result = outputMatchesFormat("bulleted_list", "- item one\n- item two\n- item three");
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("asterisk-prefixed list lines → ok:true", () => {
    const result = outputMatchesFormat("bulleted_list", "* first\n* second");
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("prose without bullet prefix → ok:false", () => {
    const result = outputMatchesFormat("bulleted_list", "first item\nsecond item\nthird item");
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toContain("bulleted");
  });
});

describe("detectNamedOutputFormat · json", () => {
  test('"return the result as JSON" → "json"', () => {
    expect(detectNamedOutputFormat("return the result as JSON")).toBe("json");
  });
  test('"a json object with fields" → "json"', () => {
    expect(detectNamedOutputFormat("produce a json object with fields x and y")).toBe("json");
  });
  test('incidental "the API returns JSON" does NOT trigger json (no output-intent)', () => {
    // "returns json" is not an output-intent phrasing the gate matches.
    expect(detectNamedOutputFormat("call the endpoint that returns json from the vendor")).toBe(
      null,
    );
  });
});

describe("outputMatchesFormat · json", () => {
  test("a JSON object string → ok", () => {
    expect(outputMatchesFormat("json", '{"city":"Berlin","max":25}').ok).toBe(true);
  });
  test("a JSON array string → ok", () => {
    expect(outputMatchesFormat("json", '[{"a":1}]').ok).toBe(true);
  });
  test("a markdown table (not JSON) → ok:false", () => {
    const r = outputMatchesFormat("json", "| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(r.ok).toBe(false);
    expect(r.missing[0]).toContain("JSON");
  });
});

describe("formatGuidance", () => {
  const formats: NamedOutputFormat[] = ["markdown_table", "csv", "html", "bulleted_list", "json"];
  for (const fmt of formats) {
    test(`${fmt} → non-empty, format-relevant guidance`, () => {
      const g = formatGuidance(fmt);
      expect(g.length).toBeGreaterThan(20);
    });
  }
  // The string-rendered formats must steer the FINAL output (json is the
  // structured default and is phrased around output_schema instead).
  for (const fmt of ["markdown_table", "csv", "html", "bulleted_list"] as NamedOutputFormat[]) {
    test(`${fmt} guidance steers the FINAL output`, () => {
      expect(formatGuidance(fmt).toUpperCase()).toContain("FINAL");
    });
  }
  test("markdown guidance names the separator row", () => {
    expect(formatGuidance("markdown_table")).toContain("| --- |");
  });
});
