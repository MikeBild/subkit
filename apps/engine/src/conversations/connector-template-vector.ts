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

export function templateEmbeddingText(t: ConnectorTemplate): string {
  return [t.name, t.slug, t.category ?? "", t.description, ...t.aliases, ...t.keywords, ...t.tags]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(". ");
}

export interface HybridEmbedder {
  available(): Promise<boolean>;
  embed(texts: string[]): Promise<number[][]>;
}

const localEmbedder: HybridEmbedder = {
  available: embeddingsAvailable,
  embed: embedTexts,
};

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

  if (!(await embedder.available())) return lexical.slice(0, args.limit);

  const nq = normalizeForExactMatch(args.query);
  const top = lexical[0]?.template;
  const exact =
    !!top &&
    (top.slug === nq ||
      normalizeForExactMatch(top.name) === nq ||
      findTemplateAliasMatches(top, nq));
  if (exact) return lexical.slice(0, args.limit);

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
