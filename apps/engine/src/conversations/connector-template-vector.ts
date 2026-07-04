// Connector-template matching — hybrid lexical + semantic vector retrieval.
//
// Measured (benchmarks/retrieval): the lexical scorer lands the right
// connector on natural-language intent 0% of the time and is blind to
// German. Adding a local multilingual embedding rerank lifts recall@5 from
// 29% → 75% on the probe set. The fusion rule, chosen by measurement (not
// a guess), is:
//
//   exact-lexical override + vector-first
//
// i.e. when the query exactly names a vendor (slug / display name / alias),
// trust the lexical top (keeps named-vendor rank1 at 100%); otherwise rank
// by query↔template cosine similarity. This beat pure vector (which
// confuses GitHub↔GitLab), a score-threshold hybrid (a spurious substring
// match could reach the threshold and override a correct vector hit), and
// RRF (FTS's full ranking is mostly substring noise that RRF over-weights).
//
// Embeddings are local (no API key, no per-query cost) and the provider is
// degradable — when the model is unavailable this falls back to the pure
// lexical scorer, so retrieval never breaks.
//
// Scope: this powers SUGGESTIONS (suggest_connector_templates), which are
// non-destructive — the user / LLM still chooses. Auto-select
// (start_connector_from_description), which *creates* a connector, stays on
// the conservative lexical+exact path: we do not auto-create from a fuzzy
// semantic match.

import { findTemplateAliasMatches } from "../connectors/template-resolver.ts";
import type { ConnectorTemplate } from "../connectors/templates.ts";
import { loadBuiltinTemplates } from "../connectors/templates.ts";
import type { DriverName } from "../connectors/types.ts";
import {
  cosineSimilarity,
  EMBEDDING_MODEL,
  embeddingsAvailable,
  embedTexts,
} from "../embeddings/local-provider.ts";
import {
  normalizeForExactMatch,
  suggestConnectorTemplates,
} from "./connector-template-intelligence.ts";

/** The text we embed per template — the metadata a semantic matcher should
 *  index. `capabilities` is an object map (not a list), so it is omitted;
 *  name + slug + category + description + aliases + keywords + tags are the
 *  free-text signal. */
export function templateEmbeddingText(t: ConnectorTemplate): string {
  return [t.name, t.slug, t.category ?? "", t.description, ...t.aliases, ...t.keywords, ...t.tags]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(". ");
}

/** The embedding surface the hybrid needs. Injected in tests with a
 *  deterministic stub so the fusion logic is verified without loading the
 *  real model; defaults to the local provider in production. */
export interface HybridEmbedder {
  available(): Promise<boolean>;
  embed(texts: string[]): Promise<number[][]>;
}

const localEmbedder: HybridEmbedder = {
  available: embeddingsAvailable,
  embed: embedTexts,
};

// In-process embedding cache keyed by (model, text), used only for the
// default local embedder. Built-in templates are static per process;
// tenant-override templates are covered because the key is the text. The
// model id is in the key so a model swap invalidates automatically.
const templateVectorCache = new Map<string, number[]>();

async function embedTemplates(
  texts: string[],
  embedder: HybridEmbedder,
  cache: boolean,
): Promise<number[][]> {
  if (!cache) return embedder.embed(texts);
  const key = (t: string): string => `${EMBEDDING_MODEL} ${t}`;
  const missing = texts.filter((t) => !templateVectorCache.has(key(t)));
  if (missing.length > 0) {
    const vecs = await embedder.embed(missing);
    if (vecs.length === missing.length) {
      for (let i = 0; i < missing.length; i++) {
        templateVectorCache.set(key(missing[i]!), vecs[i]!);
      }
    }
  }
  return texts.map((t) => templateVectorCache.get(key(t)) ?? []);
}

/**
 * Suggest connector templates with hybrid lexical + vector ranking. Falls
 * back to the pure lexical scorer when embeddings are unavailable or when
 * the query is an exact vendor match. Returns `{ template, score }` sorted
 * best-first; `score` is the lexical score on an exact match and the cosine
 * similarity otherwise (informational — callers rank by order).
 */
export async function suggestConnectorTemplatesHybrid(
  args: {
    query: string;
    limit: number;
    explicitDriver?: DriverName;
    templates?: ConnectorTemplate[];
  },
  embedder: HybridEmbedder = localEmbedder,
): Promise<Array<{ template: ConnectorTemplate; score: number }>> {
  const templates = args.templates ?? loadBuiltinTemplates();
  const lexical = suggestConnectorTemplates(args);

  // Degrade to lexical when embeddings are unavailable.
  if (!(await embedder.available())) return lexical.slice(0, args.limit);

  // Exact vendor match → lexical top is authoritative; keep lexical order.
  const nq = normalizeForExactMatch(args.query);
  const top = lexical[0]?.template;
  const exact =
    !!top &&
    (top.slug === nq ||
      normalizeForExactMatch(top.name) === nq ||
      findTemplateAliasMatches(top, nq));
  if (exact) return lexical.slice(0, args.limit);

  // Otherwise rank by semantic similarity over all templates.
  const [qVec] = await embedder.embed([args.query]);
  if (!qVec) return lexical.slice(0, args.limit);
  const tplVecs = await embedTemplates(
    templates.map(templateEmbeddingText),
    embedder,
    embedder === localEmbedder,
  );
  const ranked = templates
    .map((t, i) => ({ template: t, score: cosineSimilarity(qVec, tplVecs[i] ?? []) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, args.limit);
  return ranked.length > 0 ? ranked : lexical.slice(0, args.limit);
}
