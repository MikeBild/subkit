import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ingestDocs } from "../service.ts";
import { parseLlmsTxt } from "../sources/llms-txt.ts";
import { createDocsTestCtx, type DocsTestCtx, stubFetch } from "./setup.ts";

let ctx: DocsTestCtx;

beforeAll(async () => {
  ctx = await createDocsTestCtx("llms");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("docs-ingestion/llms-txt", () => {
  test("parseLlmsTxt extracts markdown link tuples", () => {
    const body = `# curated docs\n\n- [overview](https://ex.test/overview.md)\n- [api](https://ex.test/api.json)\n`;
    const links = parseLlmsTxt(body);
    expect(links).toEqual([
      { title: "overview", url: "https://ex.test/overview.md" },
      { title: "api", url: "https://ex.test/api.json" },
    ]);
  });

  test("ingestDocs resolves followed links (mocked)", async () => {
    const llms = `# llms.txt\n\n- [api](https://ex.test/api.json)\n- [guide](https://ex.test/guide.md)\n`;
    const openapi = {
      openapi: "3.0.0",
      info: { title: "X", version: "0.1.0" },
      paths: { "/a": { get: { summary: "a", responses: { "200": { description: "ok" } } } } },
    };
    const md = "# Guide\n\n## Setup\n\nSetup instructions.\n";
    const fetchImpl = stubFetch({
      "https://ex.test/llms.txt": { body: llms, headers: { "content-type": "text/plain" } },
      "https://ex.test/api.json": { body: JSON.stringify(openapi) },
      "https://ex.test/guide.md": { body: md, headers: { "content-type": "text/markdown" } },
    });
    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: { source_type: "llms_txt", url: "https://ex.test/llms.txt" },
        fetchImpl,
      },
      ctx.testDb.db,
    );
    // index + (overview + 1 op) + (1 section) = at least 4 chunks.
    expect(result.ingested_count).toBeGreaterThanOrEqual(4);
    expect(result.budget_exceeded).toBe(false);
  });
});
