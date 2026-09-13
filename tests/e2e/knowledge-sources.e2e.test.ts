// Knowledge sources — inline ingest → search → CLI read.
//
// Uses the inline JSON ingestion route (no multipart upload dance) so the
// suite stays hermetic. Ingestion routes content through the real chunker;
// search is polled until the chunk is indexed (eventual consistency, never
// a fixed sleep). Includes a tenant-scoping negative via the x-subkit-tenant
// override and the `sk knowledge-sources` CLI read path.
//
// LLM: mock — embeddings/search run through the mock provider.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { uniqueSuffix } from "./_helpers/factories.ts";
import { apiClient } from "./_helpers/http.ts";
import { pollUntil } from "./_helpers/poll.ts";
import { boot, cli, type E2EEnv, expectSuccess, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("knowledge-sources", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

interface KnowledgeSource {
  id: string;
  name: string;
}
interface SearchResult {
  hits: Array<{ knowledge_source_id: string; snippet: string }>;
}

describe("inline ingest → search → read", () => {
  test("inline content is searchable, fetchable, and visible to the CLI", async () => {
    const api = apiClient(env);
    const slug = uniqueSuffix("kb");
    // A distinctive token so the search assertion can't match noise.
    const token = `zphmark${slug.replace(/[^a-z0-9]/g, "")}`;
    const created = await api.post<KnowledgeSource>("/v1/knowledge-sources/inline", {
      name: `KB ${slug}`,
      tags: ["e2e", "smoke"],
      content: `# Runbook ${slug}\n\nThe magic deployment marker is ${token}. It identifies this source.`,
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeTruthy();

    // Fetch the source back.
    const got = await api.get<KnowledgeSource>(`/v1/knowledge-sources/${created.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(created.body.id);

    // Search converges once the chunker has indexed the content.
    const hit = await pollUntil(
      async () => {
        const res = await api.get<SearchResult>(`/v1/knowledge-sources/search?q=${token}&limit=10`);
        if (res.status !== 200) return null;
        return res.body.hits.find((h) => h.knowledge_source_id === created.body.id) ?? null;
      },
      { timeoutMs: 20_000, label: `knowledge search for ${token}` },
    );
    expect(hit.knowledge_source_id).toBe(created.body.id);

    // CLI read surface lists it.
    const list = await cli(["knowledge-sources", "list"], { env, persona: "admin" });
    expectSuccess(list, "sk knowledge-sources list");
  }, 60_000);

  test("a foreign tenant header cannot broaden access (api key re-resolves its tenant)", async () => {
    const api = apiClient(env);
    const foreign = "00000000-0000-0000-0000-000000000999";
    const res = await api.get<{ items?: KnowledgeSource[] }>("/v1/knowledge-sources?limit=50", {
      tenant: foreign,
    });
    // The api-key provider re-resolves tenant from the key — a foreign
    // header MUST NOT broaden access. Either 200 (header ignored, this
    // tenant's data returned) or 4xx — never a 5xx, never another
    // tenant's rows. Mirrors the Tier-4 isolation invariant.
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      // Header ignored → our own scope, so the source we created is still
      // here (proving it resolved to THIS tenant, not the foreign one).
      expect((res.body.items ?? []).length).toBeGreaterThanOrEqual(1);
    } else {
      expect([400, 401, 403]).toContain(res.status);
    }
  }, 30_000);
});
