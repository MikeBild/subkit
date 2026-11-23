import type { Executor } from "../db/index.ts";
import { log } from "../logging/index.ts";
import { TtlCache } from "../utils/index.ts";
import { knowledgeSearchCacheKey } from "./core/search-key.ts";
import { workspaceFtsConfig } from "./persistence/chunks.ts";
import {
  allTermsTsQuery,
  anyTermTsQuery,
  domainTaggedSourceIds,
  knowledgeScopeFilter,
  runKnowledgeFts,
} from "./search-fts.ts";
import { fuseKnowledgeWithVectors } from "./search-vectors.ts";
import type { KnowledgeSearchHit, SearchKnowledgeParams } from "./types.ts";

const knowledgeSearchCache = new TtlCache<KnowledgeSearchHit[]>({
  maxEntries: 256,
  ttlMs: 60_000,
});
let knowledgeSearchCacheToken = {};
let beforeKnowledgeSearchCachePublish: (() => Promise<void>) | undefined;

export function setKnowledgeSearchCachePublishHookForTests(
  hook: (() => Promise<void>) | undefined,
): void {
  beforeKnowledgeSearchCachePublish = hook;
}

export function invalidateKnowledgeCache(tenant_id: string): void {
  knowledgeSearchCacheToken = {};
  knowledgeSearchCache.invalidatePrefix(`${tenant_id}:`);
}

export function getKnowledgeSearchCacheStats(): { hits: number; misses: number; size: number } {
  return knowledgeSearchCache.stats();
}

export async function searchKnowledge(
  p: SearchKnowledgeParams,
  db: Executor,
): Promise<KnowledgeSearchHit[]> {
  const limit = Math.min(Math.max(1, p.limit ?? 10), 50);

  const cacheKey = knowledgeSearchCacheKey(p);
  const cached = knowledgeSearchCache.get(cacheKey);
  if (cached) return cached;

  if (!p.query || p.query.trim().length === 0) return [];

  const cacheToken = knowledgeSearchCacheToken;
  const scopeFilter = knowledgeScopeFilter(p);
  const config = await workspaceFtsConfig(db, p.tenant_id);

  const allTermsQuery = allTermsTsQuery(config, p.query);
  let hits = await runKnowledgeFts(db, p.tenant_id, allTermsQuery, scopeFilter, limit, [], config);
  if (hits.length === 0) {
    const anyTermQuery = anyTermTsQuery(allTermsQuery);
    const domainIds = await domainTaggedSourceIds(db, p.tenant_id, anyTermQuery, config);
    hits = await runKnowledgeFts(
      db,
      p.tenant_id,
      anyTermQuery,
      scopeFilter,
      limit,
      domainIds,
      config,
    );
  }

  const fused = await fuseKnowledgeWithVectors(db, p, hits, scopeFilter, limit);

  log.knowledge.searched({
    tenant_id: p.tenant_id,
    query_length: p.query.length,
    scope: p.scope ?? null,
    workflow_id: p.workflow_id ?? null,
    hit_count: fused.length,
    top_match_id: fused[0]?.id ?? null,
    top_rank: fused[0]?.rank ?? null,
    limit,
  });

  const beforePublish = beforeKnowledgeSearchCachePublish;
  if (beforePublish) await beforePublish();
  if (cacheToken === knowledgeSearchCacheToken) knowledgeSearchCache.set(cacheKey, fused);
  return fused;
}
