import { expect, test } from "bun:test";
import fc from "fast-check";
import { knowledgeSearchCacheKey } from "./search-key.ts";

const request = { tenant_id: "tenant", query: "Query" };

test("search identities cannot collide through tag or query delimiters", () => {
  expect(knowledgeSearchCacheKey({ ...request, tags: ["a,b"] })).not.toBe(
    knowledgeSearchCacheKey({ ...request, tags: ["a", "b"] }),
  );
  expect(knowledgeSearchCacheKey({ ...request, scope: "global", workflow_id: "a:b" })).not.toBe(
    knowledgeSearchCacheKey({ ...request, scope: "global:a", workflow_id: "b" }),
  );
  expect(knowledgeSearchCacheKey(request).startsWith("tenant:")).toBe(true);
});

test("normalization preserves limit boundaries, case folding and unordered filters", () => {
  expect(knowledgeSearchCacheKey(request)).toBe(
    knowledgeSearchCacheKey({ ...request, query: " QUERY ", limit: 10 }),
  );
  expect(knowledgeSearchCacheKey({ ...request, limit: -1 })).toBe(
    knowledgeSearchCacheKey({ ...request, limit: 1 }),
  );
  expect(knowledgeSearchCacheKey({ ...request, limit: 100 })).toBe(
    knowledgeSearchCacheKey({ ...request, limit: 50 }),
  );
  fc.assert(
    fc.property(fc.array(fc.string()), (tags) => {
      const before = [...tags];
      const first = knowledgeSearchCacheKey({ ...request, tags, knowledge_source_ids: tags });
      const reversed = [...tags].reverse();
      expect(first).toBe(
        knowledgeSearchCacheKey({ ...request, tags: reversed, knowledge_source_ids: reversed }),
      );
      expect(tags).toEqual(before);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
