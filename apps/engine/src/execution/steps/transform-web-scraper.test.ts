import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import * as loader from "../../config/loader.ts";
import { type Config, ConfigSchema } from "../../config/schema.ts";
import type { TransformStep } from "../../workflows/types.ts";
import type { StepRunContext } from "../types.ts";
import { runHtmlToMarkdown, runReadability, runStructuredData } from "./transform-web-scraper.ts";

const defaultConfig: Config = ConfigSchema.parse({
  database: { url: "postgres://test" },
});

let configSpy: ReturnType<typeof spyOn<typeof loader, "getConfig">>;

beforeAll(() => {
  configSpy = spyOn(loader, "getConfig").mockReturnValue(defaultConfig);
});
afterAll(() => {
  configSpy.mockRestore();
});
beforeEach(() => {
  configSpy.mockReturnValue(defaultConfig);
});
afterEach(() => {
  configSpy.mockClear();
});

function patchConfig(cfg: Config): void {
  configSpy.mockReturnValue(cfg);
}

function makeCtx(): StepRunContext {
  return { tenant_id: "00000000-0000-0000-0000-000000000000" } as unknown as StepRunContext;
}

function makeStep(
  language: TransformStep["language"],
  extra: Partial<TransformStep> = {},
): TransformStep {
  return {
    kind: "transform",
    id: "t",
    language,
    ...extra,
  } as TransformStep;
}

const SAMPLE_ARTICLE_HTML =
  `
  <!doctype html><html><head>
    <title>Hello World</title>
    <meta name="author" content="Jane Doe" />
    <meta property="og:title" content="OG Hello" />
    <meta property="og:site_name" content="Acme" />
    <script type="application/ld+json">{"@type":"Article","name":"Hello"}</script>
  </head><body>
    <header><nav>navigation</nav></header>
    <article>
      <h1>Hello World</h1>
      <p>This is a representative article with enough content to satisfy Readability's heuristics. ` +
  "Lorem ipsum dolor sit amet ".repeat(40) +
  `</p>
      <script>console.log("noise")</script>
      <style>body{color:red}</style>
    </article>
    <footer>footer</footer>
  </body></html>
`;

describe("transform-web-scraper / readability", () => {
  test("returns ReadabilityOutput envelope with non-empty title + content_html", () => {
    patchConfig(defaultConfig);
    const result = runReadability({
      ctx: makeCtx(),
      step: makeStep("readability"),
      input: { html: SAMPLE_ARTICLE_HTML, url: "https://example.com/post" },
    });
    expect(result.status).toBe("succeeded");
    const out = (result as { output: Record<string, unknown> }).output;
    expect(out.url).toBe("https://example.com/post");
    expect(typeof out.title).toBe("string");
    expect(out.title).toContain("Hello");
    expect(typeof out.content_html).toBe("string");
    expect((out.content_html as string).length).toBeGreaterThan(0);
    expect(typeof out.length).toBe("number");
  });

  test("emits extract_too_large when input exceeds max_chars", () => {
    patchConfig(defaultConfig);
    const result = runReadability({
      ctx: makeCtx(),
      step: makeStep("readability", { readability: { max_chars: 100 } }),
      input: SAMPLE_ARTICLE_HTML,
    });
    expect(result.status).toBe("failed");
    expect((result as { error: { code: string } }).error.code).toBe("extract_too_large");
  });

  test("emits transform_error when input is not parseable", () => {
    patchConfig(defaultConfig);
    const result = runReadability({
      ctx: makeCtx(),
      step: makeStep("readability"),
      input: 42,
    });
    expect(result.status).toBe("failed");
    expect((result as { error: { code: string } }).error.code).toBe("transform_error");
  });
});

describe("transform-web-scraper / html-to-markdown", () => {
  test("strips script and style elements and produces markdown", () => {
    patchConfig(defaultConfig);
    const html = "<html><body><h1>Hi</h1><script>bad</script><p>Body</p></body></html>";
    const result = runHtmlToMarkdown({
      ctx: makeCtx(),
      step: makeStep("html-to-markdown"),
      input: { html, url: "https://example.com/" },
    });
    expect(result.status).toBe("succeeded");
    const out = (result as { output: Record<string, unknown> }).output;
    expect(typeof out.markdown).toBe("string");
    expect(out.markdown).toContain("Hi");
    expect(out.markdown).toContain("Body");
    expect(out.markdown).not.toContain("bad");
    expect(out.url).toBe("https://example.com/");
    expect(out.truncated).toBe(false);
    expect(Array.isArray(out.stripped_elements)).toBe(true);
    expect((out.stripped_elements as string[]).includes("script")).toBe(true);
  });

  test("emits extract_too_large when output exceeds max_chars (default)", () => {
    patchConfig(defaultConfig);
    const html = `<html><body>${"<p>x</p>".repeat(2000)}</body></html>`;
    const result = runHtmlToMarkdown({
      ctx: makeCtx(),
      step: makeStep("html-to-markdown", { markdown: { max_chars: 50 } }),
      input: html,
    });
    expect(result.status).toBe("failed");
    expect((result as { error: { code: string } }).error.code).toBe("extract_too_large");
  });

  test("soft-truncates when markdown.truncate=true", () => {
    patchConfig(defaultConfig);
    const html = `<html><body>${"<p>x</p>".repeat(2000)}</body></html>`;
    const result = runHtmlToMarkdown({
      ctx: makeCtx(),
      step: makeStep("html-to-markdown", { markdown: { max_chars: 50, truncate: true } }),
      input: html,
    });
    expect(result.status).toBe("succeeded");
    const out = (result as { output: Record<string, unknown> }).output;
    expect(out.truncated).toBe(true);
    expect((out.markdown as string).length).toBeLessThanOrEqual(50);
  });

  test("accepts a ReadabilityOutput envelope (chained transforms)", () => {
    patchConfig(defaultConfig);
    const result = runHtmlToMarkdown({
      ctx: makeCtx(),
      step: makeStep("html-to-markdown"),
      input: {
        content_html: "<p>article body</p>",
        url: "https://example.com/post",
      },
    });
    expect(result.status).toBe("succeeded");
    const out = (result as { output: Record<string, unknown> }).output;
    expect(out.markdown).toContain("article body");
    expect(out.url).toBe("https://example.com/post");
  });
});

describe("transform-web-scraper / structured-data", () => {
  test("extracts JSON-LD + OpenGraph and reports found_any", () => {
    patchConfig(defaultConfig);
    const result = runStructuredData({
      ctx: makeCtx(),
      step: makeStep("structured-data"),
      input: { html: SAMPLE_ARTICLE_HTML, url: "https://example.com/post" },
    });
    expect(result.status).toBe("succeeded");
    const out = (result as { output: Record<string, unknown> }).output;
    expect(out.found_any).toBe(true);
    expect(Array.isArray(out.json_ld)).toBe(true);
    expect((out.json_ld as unknown[]).length).toBeGreaterThan(0);
    expect((out.opengraph as Record<string, string>)["og:title"]).toBe("OG Hello");
  });

  test("emits structured_data_not_found when types requested and nothing matches", () => {
    patchConfig(defaultConfig);
    const result = runStructuredData({
      ctx: makeCtx(),
      step: makeStep("structured-data", { structured_data: { types: ["json-ld"] } }),
      input: "<html><body><p>no structured data</p></body></html>",
    });
    expect(result.status).toBe("failed");
    expect((result as { error: { code: string } }).error.code).toBe("structured_data_not_found");
  });
});

describe("transform-web-scraper / output_schema validation", () => {
  test("rejects envelope that violates a declared output_schema", () => {
    patchConfig(defaultConfig);
    const result = runHtmlToMarkdown({
      ctx: makeCtx(),
      step: makeStep("html-to-markdown", {
        output_schema: { type: "object", required: ["title"] } as Record<string, unknown>,
      }),
      input: "<html><body><p>no title field in MarkdownOutput</p></body></html>",
    });
    expect(result.status).toBe("failed");
    expect((result as { error: { code: string } }).error.code).toBe("output_schema_violation");
  });

  test("passes envelope that satisfies output_schema", () => {
    patchConfig(defaultConfig);
    const result = runHtmlToMarkdown({
      ctx: makeCtx(),
      step: makeStep("html-to-markdown", {
        output_schema: { type: "object", required: ["markdown"] } as Record<string, unknown>,
      }),
      input: "<p>ok</p>",
    });
    expect(result.status).toBe("succeeded");
  });
});

describe("transform-web-scraper / envelope JSON round-trip", () => {
  test("every envelope serialises and deserialises identically", () => {
    patchConfig(defaultConfig);
    const out1 = runHtmlToMarkdown({
      ctx: makeCtx(),
      step: makeStep("html-to-markdown"),
      input: "<p>x</p>",
    });
    const out2 = runStructuredData({
      ctx: makeCtx(),
      step: makeStep("structured-data"),
      input: SAMPLE_ARTICLE_HTML,
    });
    for (const r of [out1, out2]) {
      const out = (r as { output: unknown }).output;
      const roundTripped = JSON.parse(JSON.stringify(out));
      expect(roundTripped).toEqual(out);
    }
  });
});
