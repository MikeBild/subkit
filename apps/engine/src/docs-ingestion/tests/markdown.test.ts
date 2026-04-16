import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ingestDocs } from "../service.ts";
import { chunkMarkdown } from "../sources/markdown.ts";
import { createDocsTestCtx, type DocsTestCtx } from "./setup.ts";

let ctx: DocsTestCtx;

beforeAll(async () => {
  ctx = await createDocsTestCtx("markdown");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("docs-ingestion/markdown", () => {
  test("chunkMarkdown splits on headings and returns one chunk per section", () => {
    const md = `# Top\n\nIntro paragraph.\n\n## Section A\n\nAlpha content.\n\n## Section B\n\nBravo content.`;
    const chunks = chunkMarkdown(md);
    // A single H1 + multiple H2s → split on H2, yielding 2 section chunks.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const titles = chunks.map((c) => c.title);
    expect(titles).toContain("Section A");
    expect(titles).toContain("Section B");
    // Section A body keeps its content.
    const a = chunks.find((c) => c.title === "Section A");
    expect(a?.content).toContain("Alpha content");
  });

  test("chunkMarkdown with no headings emits a single chunk", () => {
    const chunks = chunkMarkdown("just one line");
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.title).toBeNull();
  });

  test("ingestDocs accepts raw markdown content", async () => {
    const md = `# Top\n\n## Alpha\n\nFirst alpha.\n\n## Beta\n\nSecond beta.\n`;
    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: { source_type: "markdown", content: md },
      },
      ctx.testDb.db,
    );
    expect(result.ingested_count).toBeGreaterThanOrEqual(2);
    expect(result.budget_exceeded).toBe(false);
    expect(result.total_bytes).toBeGreaterThan(0);
  });
});
