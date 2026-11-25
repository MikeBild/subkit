import { describe, expect, test } from "bun:test";
import {
  declaredMarkdownSource,
  declaredSecretValues,
  pickResultMarkdown,
  RESULT_MARKDOWN_MAX_BYTES,
  resultMarkdown,
} from "./result-markdown.ts";

const markdownString = { type: "string", contentMediaType: "text/markdown" };

describe("declaredMarkdownSource", () => {
  test("the whole output is the result when the root schema is marked as Markdown", () => {
    expect(declaredMarkdownSource(markdownString)).toEqual({ kind: "root" });
  });

  test("the first top-level property marked as Markdown is the result", () => {
    expect(
      declaredMarkdownSource({
        type: "object",
        properties: { count: { type: "number" }, report: markdownString, notes: markdownString },
      }),
    ).toEqual({ kind: "field", name: "report" });
  });

  test("a schema without a Markdown mark declares nothing", () => {
    expect(declaredMarkdownSource({ type: "object", properties: { a: { type: "string" } } })).toBe(
      null,
    );
    expect(declaredMarkdownSource(undefined)).toBe(null);
  });
});

describe("pickResultMarkdown", () => {
  test("a declared field is read from the output", () => {
    expect(
      pickResultMarkdown(
        { report: "# Done", result_markdown: "ignored" },
        { type: "object", properties: { report: markdownString } },
      ),
    ).toBe("# Done");
  });

  test("a string output under a Markdown root is the result", () => {
    expect(pickResultMarkdown("## Summary", markdownString)).toBe("## Summary");
  });

  test("without a declaration the result_markdown field is used", () => {
    expect(pickResultMarkdown({ result_markdown: "- one\n- two" }, undefined)).toBe("- one\n- two");
  });

  test("blank text, non-strings and outputs without the field give no result", () => {
    expect(pickResultMarkdown({ result_markdown: "   " }, undefined)).toBe(null);
    expect(pickResultMarkdown({ result_markdown: 42 }, undefined)).toBe(null);
    expect(pickResultMarkdown("plain text", undefined)).toBe(null);
    expect(pickResultMarkdown(null, undefined)).toBe(null);
  });
});

describe("resultMarkdown", () => {
  test("secret shapes and credentials in links are redacted", () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const out = resultMarkdown(
      {
        result_markdown: `Token ${token}\n[open](https://bob:hunter2@example.com/x?access_token=abc&page=2)`,
      },
      undefined,
    );
    expect(out?.markdown).not.toContain(token);
    expect(out?.markdown).not.toContain("hunter2");
    expect(out?.markdown).not.toContain("access_token=abc");
    expect(out?.markdown).toContain("page=2");
    expect(out?.truncated).toBe(false);
  });

  test("text beyond the cap is cut and marked truncated", () => {
    const out = resultMarkdown({ result_markdown: "x".repeat(20) }, undefined, [], 8);
    expect(out).toEqual({ markdown: "xxxxxxxx", truncated: true });
  });

  test("the cap counts UTF-8 bytes, so accented text over 64 KiB is cut", () => {
    const accented = "é".repeat(40_000);
    const out = resultMarkdown({ result_markdown: accented }, undefined);
    expect(out?.truncated).toBe(true);
    expect(Buffer.byteLength(out?.markdown ?? "", "utf8")).toBe(RESULT_MARKDOWN_MAX_BYTES);
  });

  test("the cut never splits a code point", () => {
    const out = resultMarkdown({ result_markdown: `a${"😀".repeat(10)}` }, undefined, [], 8);
    expect(out).toEqual({ markdown: "a😀", truncated: true });
    expect(out?.markdown).not.toContain("�");
  });

  test("ASCII exactly at the cap is kept whole", () => {
    const exact = "x".repeat(RESULT_MARKDOWN_MAX_BYTES);
    expect(resultMarkdown({ result_markdown: exact }, undefined)).toEqual({
      markdown: exact,
      truncated: false,
    });
  });

  test("no Markdown means no result", () => {
    expect(resultMarkdown({ ok: true }, undefined)).toBe(null);
  });
});

describe("declaredSecretValues", () => {
  const steps = [
    { id: "login", kind: "request", outputs: { token: { secret: true }, user: {} } },
    {
      id: "branch",
      kind: "branch",
      branches: [{ steps: [{ id: "inner", kind: "request", outputs: { key: { secret: true } } }] }],
    },
  ];
  const scope = {
    login: { data: { token: "opaque-session-value", user: "ada" } },
    inner: { data: { key: "abc" } },
  };

  test("values of outputs a request step marks secret are collected, also in nested steps", () => {
    expect(
      declaredSecretValues(steps, { ...scope, inner: { data: { key: "nested-secret" } } }),
    ).toEqual(["opaque-session-value", "nested-secret"]);
  });

  test("very short values are left alone so ordinary words are not masked", () => {
    expect(declaredSecretValues(steps, scope)).toEqual(["opaque-session-value"]);
  });

  test("a secret output that reaches the Markdown is masked", () => {
    const out = resultMarkdown(
      { result_markdown: "Signed in with opaque-session-value as ada" },
      undefined,
      declaredSecretValues(steps, scope),
    );
    expect(out?.markdown).toBe("Signed in with ***REDACTED:secret_output*** as ada");
  });
});
