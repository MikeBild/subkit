// Unit tests for the outbound CommonMark -> platform-dialect formatter.

import { describe, expect, test } from "bun:test";

import { formatChatText } from "../outbound-format.ts";

describe("formatChatText — google_chat dialect", () => {
  const g = (s: string) => formatChatText("google_chat", s);

  test("**bold** collapses to single-asterisk *bold*", () => {
    expect(g("**Workflows (36 total):**")).toBe("*Workflows (36 total):*");
    expect(g("a **b** c")).toBe("a *b* c");
  });

  test("__bold__ collapses to *bold*", () => {
    expect(g("__x__")).toBe("*x*");
  });

  test("literal bullet, dash, and star bullets all normalize to '* '", () => {
    expect(g("• item")).toBe("* item");
    expect(g("- item")).toBe("* item");
    expect(g("* item")).toBe("* item");
  });

  test("nested bullets keep their indentation", () => {
    expect(g("    - nested")).toBe("    * nested");
  });

  test("markdown link becomes <url|text>", () => {
    expect(g("see [the docs](https://example.com)")).toBe("see <https://example.com|the docs>");
  });

  test("ATX headers degrade to a bold line", () => {
    expect(g("## Charge Point Messaging")).toBe("*Charge Point Messaging*");
    expect(g("# Title #")).toBe("*Title*");
  });

  test("strikethrough ~~x~~ -> ~x~", () => {
    expect(g("~~gone~~")).toBe("~gone~");
  });

  test("numbered lists pass through as literal text", () => {
    expect(g("1. first\n2. second")).toBe("1. first\n2. second");
  });

  test("blockquote passes through", () => {
    expect(g("> quoted")).toBe("> quoted");
  });

  test("inline code is protected — markers inside are never rewritten", () => {
    expect(g("run `**not bold**` please")).toBe("run `**not bold**` please");
  });

  test("fenced code block is preserved verbatim", () => {
    const src = 'before\n```json\n{ "a": 1 }\n```\nafter';
    expect(g(src)).toBe(src);
  });

  test("a fenced block containing bullets/bold is untouched, prose around it is converted", () => {
    const src = "**Result:**\n```\n- raw\n**raw**\n```";
    expect(g(src)).toBe("*Result:*\n```\n- raw\n**raw**\n```");
  });

  test("no double-conversion: already single-asterisk stays single", () => {
    expect(g("*already*")).toBe("*already*");
  });

  test("digits and decimals in prose are never treated as placeholders", () => {
    // Regression: an empty/greedy sentinel would eat numbers like 16.9.
    expect(g("Min 16.9 Max 20.9 across 36 items")).toBe("Min 16.9 Max 20.9 across 36 items");
  });

  test("empty / whitespace input is a no-op", () => {
    expect(g("")).toBe("");
    expect(g("   ")).toBe("   ");
  });
});

describe("formatChatText — slack dialect", () => {
  const s = (t: string) => formatChatText("slack", t);

  test("bold, bullet, and link convert the same way as Google", () => {
    expect(s("**bold**")).toBe("*bold*");
    expect(s("• item")).toBe("* item");
    expect(s("[t](https://x.io)")).toBe("<https://x.io|t>");
  });
});

describe("formatChatText — passthrough platforms", () => {
  test("teams renders CommonMark natively — passed through verbatim", () => {
    const src = "**bold** and\n- a bullet\n[link](https://x.io)";
    expect(formatChatText("teams", src)).toBe(src);
  });

  test("sk_cli has its own renderer — passed through verbatim", () => {
    const src = "**bold**\n- item";
    expect(formatChatText("sk_cli", src)).toBe(src);
  });
});

describe("formatChatText — GFM pipe tables", () => {
  const g = (s: string) => formatChatText("google_chat", s);

  test("3-column table becomes bold-head + bullets (google_chat)", () => {
    const table = [
      "| Aspekt | Knowledge Sources | Skills |",
      "|--------|-------------------|--------|",
      "| **Zweck** | Tenant-spezifisches Referenzmaterial | Interne Verhaltensspezifikationen |",
      "| Quelle | Vom Operator hochgeladen | Vordefiniert im Skill-Katalog |",
    ].join("\n");
    const out = g(table);
    // Row key becomes a bold head; other columns become labeled bullets.
    expect(out).toContain("*Zweck*");
    expect(out).toContain("* Knowledge Sources: Tenant-spezifisches Referenzmaterial");
    expect(out).toContain("* Skills: Interne Verhaltensspezifikationen");
    expect(out).toContain("*Quelle*");
    expect(out).toContain("* Knowledge Sources: Vom Operator hochgeladen");
    // No raw table syntax survives to render as literal pipes.
    expect(out).not.toContain("|");
    expect(out).not.toContain("---");
  });

  test("2-column key/value table becomes inline '*key*: value'", () => {
    const table = ["| Key | Value |", "|-----|-------|", "| Zweck | Referenzmaterial |"].join("\n");
    expect(g(table)).toBe("*Zweck*: Referenzmaterial");
  });

  test("prose around a table is preserved; only the table block is linearized", () => {
    const src = [
      "Hier der Vergleich:",
      "",
      "| A | B |",
      "|---|---|",
      "| x | y |",
      "",
      "Fertig.",
    ].join("\n");
    const out = g(src);
    expect(out).toContain("Hier der Vergleich:");
    expect(out).toContain("*x*: y");
    expect(out).toContain("Fertig.");
    expect(out).not.toContain("|");
  });

  test("a pipe inside a fenced code block is NOT treated as a table", () => {
    const src = ["```", "| not | a | table |", "|---|---|---|", "```"].join("\n");
    // The fence is protected verbatim, so its pipes survive untouched.
    expect(g(src)).toContain("| not | a | table |");
  });

  test("teams and sk_cli pass tables through unchanged (native table rendering)", () => {
    const table = ["| A | B |", "|---|---|", "| x | y |"].join("\n");
    expect(formatChatText("teams", table)).toBe(table);
    expect(formatChatText("sk_cli", table)).toBe(table);
  });
});
