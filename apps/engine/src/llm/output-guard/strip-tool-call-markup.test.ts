import { describe, expect, test } from "bun:test";

import { stripLeakedToolCallMarkup } from "./strip-tool-call-markup.ts";

describe("stripLeakedToolCallMarkup", () => {
  test("strips a leaked <function_calls> block but keeps the prose", () => {
    const input = [
      "Knowledge sources: checking now.",
      "<function_calls>",
      '<invoke name="list_knowledge_sources">',
      "</invoke>",
      "</function_calls>",
    ].join("\n");
    const { text, stripped } = stripLeakedToolCallMarkup(input);
    expect(stripped).toBe(1);
    expect(text).toBe("Knowledge sources: checking now.");
    expect(text).not.toContain("function_calls");
    expect(text).not.toContain("invoke");
  });

  test("strips multiple leaked blocks", () => {
    const input = [
      "ok",
      '<function_calls><invoke name="list_knowledge_sources"></invoke></function_calls>',
      '<function_calls><invoke name="list_attachments"></invoke></function_calls>',
    ].join("\n");
    const { text, stripped } = stripLeakedToolCallMarkup(input);
    expect(stripped).toBe(2);
    expect(text).toBe("ok");
  });

  test("strips the antml:-namespaced variant", () => {
    const input = 'before\n<function_calls><invoke name="x"></invoke></function_calls>';
    const { text, stripped } = stripLeakedToolCallMarkup(input);
    expect(stripped).toBe(1);
    expect(text).toBe("before");
  });

  test("strips a stray <invoke name=…> block not wrapped in function_calls", () => {
    const input = 'sure\n<invoke name="list_workflows">\n</invoke>';
    const { text, stripped } = stripLeakedToolCallMarkup(input);
    expect(stripped).toBe(1);
    expect(text).toBe("sure");
  });

  test("strips a truncated (unclosed) opener to end of text", () => {
    const input = 'partial answer\n<function_calls>\n<invoke name="list_skills">';
    const { text, stripped } = stripLeakedToolCallMarkup(input);
    expect(stripped).toBe(1);
    expect(text).toBe("partial answer");
  });

  test("leaves ordinary prose untouched (no false positives)", () => {
    const clean = "Here are your 9 connectors and 25 workflows. Want details on any?";
    expect(stripLeakedToolCallMarkup(clean)).toEqual({ text: clean, stripped: 0 });
  });

  test("does not touch a backtick mention of a tool name", () => {
    const prose = "Use `list_workflows` to enumerate them, or ask me to run one.";
    expect(stripLeakedToolCallMarkup(prose)).toEqual({ text: prose, stripped: 0 });
  });

  test("text with no angle bracket short-circuits unchanged", () => {
    const prose = "All workflows healthy.";
    expect(stripLeakedToolCallMarkup(prose)).toEqual({ text: prose, stripped: 0 });
  });
});
