import { describe, expect, test } from "bun:test";
import { createBudgetState, MAX_LINKS, PER_PAGE_BYTES } from "../budgets.ts";
import { fingerprintChunks } from "../chunker.ts";
import { ingestLlmsTxt } from "../sources/llms-txt.ts";

describe("docs-ingestion/budget-caps", () => {
  test("a 4 MB single chunk is trimmed and marked truncated", () => {
    const oversized = "a".repeat(4 * 1024 * 1024);
    const truncates: string[] = [];
    const out = fingerprintChunks([{ title: "huge", content: oversized }], {
      splitBudget: 8 * 1024 * 1024,
      onTruncate: (m) => truncates.push(m),
    });
    expect(out.length).toBe(1);
    expect(out[0]?.byte_size).toBeLessThanOrEqual(PER_PAGE_BYTES);
    expect(out[0]?.truncated).toBe(true);
    expect(truncates.length).toBe(1);
  });

  test("llms.txt link follower caps at 20 even when 25 links are present", async () => {
    const indexUrl = "https://docs.test/llms.txt";
    const links = Array.from({ length: 25 }, (_, i) => `https://docs.test/page-${i}.md`);
    const indexBody = links.map((u, i) => `- [page ${i}](${u})`).join("\n");

    let pageFetches = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === indexUrl) {
        return new Response(indexBody, {
          status: 200,
          headers: { "content-type": "text/markdown" },
        });
      }
      pageFetches += 1;
      return new Response(`# page\n\nbody for ${url}\n`, {
        status: 200,
        headers: { "content-type": "text/markdown" },
      });
    }) as typeof fetch;

    const state = createBudgetState();
    const result = await ingestLlmsTxt(indexUrl, state, fetchImpl);
    expect(result.followed).toBeLessThanOrEqual(MAX_LINKS);
    expect(result.followed).toBe(MAX_LINKS);
    expect(pageFetches).toBe(MAX_LINKS);
    expect(state.links_followed).toBe(MAX_LINKS);
  });
});
