import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as loader from "../../config/loader.ts";
import { type Config, ConfigSchema } from "../../config/schema.ts";
import templates from "../../connectors/templates.json";
import type { TransformStep } from "../../workflows/types.ts";
import type { StepRunContext } from "../types.ts";
import { runTransformStep } from "./transform.ts";
import { transformInputFor } from "./transform-input.ts";

const defaultConfig: Config = ConfigSchema.parse({ database: { url: "postgres://test" } });
let configSpy: ReturnType<typeof spyOn<typeof loader, "getConfig">>;

beforeAll(() => {
  configSpy = spyOn(loader, "getConfig").mockReturnValue(defaultConfig);
});
afterAll(() => {
  configSpy.mockRestore();
});

function makeCtx(): StepRunContext {
  return {
    tenant_id: "00000000-0000-0000-0000-000000000000",
    execution_id: "00000000-0000-0000-0000-000000000001",
    signal: new AbortController().signal,
    started_at: new Date(0),
  } as unknown as StepRunContext;
}

const fetchedHtml = "<html><body><h1>Fetched page</h1><p>From the fetch step.</p></body></html>";
const scope = {
  fetch: { data: fetchedHtml, status_code: 200, duration_ms: 1, error: null },
  $item: { page: { html: "<p>Loop item page</p>" } },
};
const workflowInput = { url: "https://example.test/article" };

function markdownStep(extra: Partial<TransformStep> = {}): TransformStep {
  return { kind: "transform", id: "to_markdown", language: "html-to-markdown", ...extra };
}

describe("transformInputFor", () => {
  test("without input_from the transform keeps the workflow input", () => {
    expect(transformInputFor(markdownStep(), scope, workflowInput)).toEqual({
      ok: true,
      value: workflowInput,
    });
  });

  test("input_from resolves an earlier step output and the loop item", () => {
    expect(
      transformInputFor(markdownStep({ input_from: "fetch.data" }), scope, workflowInput),
    ).toEqual({ ok: true, value: fetchedHtml });
    expect(
      transformInputFor(markdownStep({ input_from: "$item.page.html" }), scope, workflowInput),
    ).toEqual({ ok: true, value: "<p>Loop item page</p>" });
  });

  test("a path that resolves to nothing is reported", () => {
    const outcome = transformInputFor(
      markdownStep({ input_from: "fetch.body" }),
      scope,
      workflowInput,
    );
    expect(outcome.ok).toBe(false);
  });
});

describe("runTransformStep with input_from", () => {
  test("html-to-markdown converts the referenced step output instead of the workflow input", async () => {
    const result = await runTransformStep({
      ctx: makeCtx(),
      step: markdownStep({ input_from: "fetch.data" }),
      scope,
      input: workflowInput,
    });
    expect(result.status).toBe("succeeded");
    expect((result.output as { markdown: string }).markdown).toContain("# Fetched page");
  });

  test("without input_from html-to-markdown still sees the workflow input", async () => {
    const result = await runTransformStep({
      ctx: makeCtx(),
      step: markdownStep(),
      scope,
      input: workflowInput,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("transform_error");
  });

  test("a missing referenced value fails with a named error", async () => {
    const result = await runTransformStep({
      ctx: makeCtx(),
      step: markdownStep({ input_from: "fetch.body" }),
      scope,
      input: workflowInput,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("transform_input_missing");
    expect(result.error?.message).toContain("fetch.body");
  });
});

describe("web scraper recipe URL preservation", () => {
  const recipes = templates.find((template) => template.slug === "web-scraper")!.recipes;
  if (!recipes) throw new Error("Web scraper recipes are missing");
  for (const slug of [
    "fetch-url-as-markdown",
    "extract-main-content",
    "crawl-sitemap-to-markdown",
  ]) {
    test(`${slug} preserves source URLs and article link bases`, async () => {
      const recipe = recipes.find((recipe) => recipe.slug === slug)!;
      const urls: [string, string] = [
        "https://example.test/news/first",
        "https://example.test/docs/second",
      ];
      const html = `<article><h1>Fetched page</h1><p>${"Article content. ".repeat(80)}<a href="../related">Related</a></p></article>`;
      const recipeScope: Record<string, { data: unknown }> = {
        fetch: { data: html },
        fetch_sitemap: { data: { urlset: { url: urls.map((loc) => ({ loc })) } } },
        fetch_page: { data: urls.map(() => ({ fetch_page: { data: html } })) },
      };
      for (const rawStep of recipe.workflow!.steps) {
        if (rawStep.kind !== "transform") continue;
        const step = rawStep as TransformStep;
        const run = async (itemScope: Record<string, unknown>) => {
          const result = await runTransformStep({
            ctx: makeCtx(),
            step,
            scope: itemScope,
            input: { url: urls[0] },
          });
          expect(result.status).toBe("succeeded");
          return result.output;
        };
        if (step.for_each) {
          const items = new Function(`return (${step.for_each})`)()(recipeScope);
          const data = [];
          for (const item of items) {
            data.push({ [step.id]: { data: await run({ ...recipeScope, $item: item }) } });
          }
          recipeScope[step.id] = { data };
        } else {
          recipeScope[step.id] = { data: await run(recipeScope) };
        }
      }
      const markdown = recipeScope.to_markdown?.data as { url: string };
      const readable = recipeScope.readable?.data as { url: string };
      const envelope = recipeScope.envelope?.data as { markdown: string };
      const pages = recipeScope.pages?.data as { url: string; markdown: string }[];
      if (slug === "fetch-url-as-markdown") {
        expect(markdown.url).toBe(urls[0]);
      } else if (slug === "extract-main-content") {
        expect(readable.url).toBe(urls[0]);
        expect(envelope.markdown).toContain("[Related](https://example.test/related)");
      } else {
        if (!recipeScope.readable) throw new Error("Readable recipe output is missing");
        expect(pages.map((page: { url: string }) => page.url)).toEqual(urls);
        for (const page of pages) {
          expect(page.markdown).toContain("[Related](https://example.test/related)");
        }
        expect(
          (recipeScope.readable.data as { readable: { data: { url: string } } }[]).map(
            (entry) => entry.readable.data.url,
          ),
        ).toEqual(urls);
      }
    });
  }
});
