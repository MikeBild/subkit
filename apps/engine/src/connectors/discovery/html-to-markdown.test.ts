// Pure-function tests for the HTML→Markdown helper.

import { describe, expect, test } from "bun:test";

import { htmlToMarkdown, looksLikeHtml } from "./html-to-markdown.ts";

describe("looksLikeHtml", () => {
  test("detects HTML5 doctype, html/body tags, and inline tags", () => {
    expect(looksLikeHtml("<!DOCTYPE html><html><body><h1>x</h1></body></html>")).toBe(true);
    expect(looksLikeHtml('<div class="docs">stuff</div>')).toBe(true);
    expect(looksLikeHtml("<p>hi</p>")).toBe(true);
  });

  test("rejects markdown / plain text / JSON", () => {
    expect(looksLikeHtml("# heading\n\nsome paragraph\n- item")).toBe(false);
    expect(looksLikeHtml("plain text without tags")).toBe(false);
    expect(looksLikeHtml('{"json": true}')).toBe(false);
    expect(looksLikeHtml("")).toBe(false);
  });
});

describe("htmlToMarkdown", () => {
  test("converts headings, lists, and links to Markdown", () => {
    const html = `
      <h1>API Reference</h1>
      <p>Welcome to the docs.</p>
      <h2>Endpoints</h2>
      <ul>
        <li><a href="/users">List users</a></li>
        <li><a href="/orders">List orders</a></li>
      </ul>
    `;
    const md = htmlToMarkdown(html);
    expect(md).toContain("# API Reference");
    expect(md).toContain("Welcome to the docs.");
    expect(md).toContain("## Endpoints");
    expect(md).toContain("[List users](/users)");
    expect(md).toContain("[List orders](/orders)");
  });

  test("strips script / style / noscript noise", () => {
    const html = `
      <html><head>
        <style>body { color: red; }</style>
        <script>console.log('hi');</script>
      </head><body>
        <noscript>js required</noscript>
        <h1>Real content</h1>
      </body></html>
    `;
    const md = htmlToMarkdown(html);
    expect(md).toContain("Real content");
    expect(md).not.toContain("color: red");
    expect(md).not.toContain("console.log");
    expect(md).not.toContain("js required");
  });

  test("returns input unchanged when not HTML", () => {
    const md = "# Already Markdown\n\n- bullet";
    expect(htmlToMarkdown(md)).toBe(md);
  });

  test("returns empty input untouched", () => {
    expect(htmlToMarkdown("")).toBe("");
  });
});
