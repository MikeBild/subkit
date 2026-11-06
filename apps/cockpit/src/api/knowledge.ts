import type { components } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";

type KnowledgeChunkList = components["schemas"]["KnowledgeChunkListResponse"];

const CHUNK_PAGE = 200;

export async function loadKnowledgeChunks(sourceId: string): Promise<KnowledgeChunkList> {
  const page = (offset: number) =>
    apiCall("get", "/v1/knowledge-sources/{id}/chunks", {
      path: { id: sourceId },
      query: offset ? { limit: CHUNK_PAGE, offset } : { limit: CHUNK_PAGE },
    });
  const first = await page(0);
  const items = [...first.items];
  while (items.length < first.chunk_count) {
    const next = await page(items.length);
    if (next.items.length === 0 || next.chunk_count !== first.chunk_count)
      throw new Error("knowledge-chunks-changed");
    items.push(...next.items);
  }
  return { ...first, items };
}
