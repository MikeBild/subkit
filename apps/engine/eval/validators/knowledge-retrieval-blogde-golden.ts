import { cosineSimilarity, EMBEDDING_MODEL } from "../../src/embeddings/local-provider.ts";
import { VECTOR_MIN_COSINE } from "../../src/embeddings/vector-rerank.ts";
import { bestPassage, queryTerms } from "../../src/knowledge/core/passage.ts";
import { fuseByReciprocalRank } from "../../src/knowledge/core/rank-fusion.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface CorpusEntry {
  id: string;
  title?: string;
  content?: string;
  vector?: number[];
}

interface Input {
  k: number;
  min_recall_at_k: number;
  min_mrr: number;
  abstention_max_cosine?: number;
  embedding_model?: string;
  corpus: CorpusEntry[];
  golden: Array<{ query: string; relevant_ids: string[]; vector?: number[] }>;
  abstention: Array<{ query: string; vector?: number[] }>;
}

function textOf(entry: CorpusEntry): string {
  return `${entry.title ?? ""} ${entry.content ?? ""}`.toLowerCase();
}

function textRanking(corpus: readonly CorpusEntry[], query: string): CorpusEntry[] {
  const terms = queryTerms(query);
  return corpus
    .map((entry) => {
      const text = textOf(entry);
      return { entry, matched: terms.filter((term) => text.includes(term)).length };
    })
    .filter((scored) => scored.matched > 0)
    .sort((a, b) => b.matched - a.matched)
    .map((scored) => scored.entry);
}

function vectorRanking(
  corpus: readonly CorpusEntry[],
  queryVec: readonly number[],
  floor: number,
): Array<{ entry: CorpusEntry; score: number }> {
  return corpus
    .map((entry) => ({ entry, score: cosineSimilarity(queryVec, entry.vector as number[]) }))
    .filter((scored) => scored.score >= floor)
    .sort((a, b) => b.score - a.score);
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;

  if (input.embedding_model !== EMBEDDING_MODEL) {
    return {
      pass: false,
      reason:
        `fixture vectors were generated for '${input.embedding_model ?? "(none)"}' but the engine uses ` +
        `'${EMBEDDING_MODEL}' — re-run apps/engine/eval/gen-blogde-golden-vectors.ts`,
    };
  }
  const missing = [
    ...input.corpus.filter((c) => !c.vector),
    ...input.golden.filter((g) => !g.vector),
    ...input.abstention.filter((a) => !a.vector),
  ];
  if (missing.length > 0) {
    return {
      pass: false,
      reason: `${missing.length} fixture entries lack vectors — re-run apps/engine/eval/gen-blogde-golden-vectors.ts`,
    };
  }

  const search = (query: string, queryVec: number[]): CorpusEntry[] =>
    fuseByReciprocalRank({
      lists: [
        textRanking(input.corpus, query),
        vectorRanking(input.corpus, queryVec, VECTOR_MIN_COSINE).map((scored) => scored.entry),
      ],
      idOf: (entry) => entry.id,
      limit: input.corpus.length,
    });

  const failures: string[] = [];
  let hitsAtK = 0;
  let mrrSum = 0;
  for (const g of input.golden) {
    const ranked = search(g.query, g.vector as number[]);
    const relevant = new Set(g.relevant_ids);
    const firstIdx = ranked.findIndex((r) => relevant.has(r.id));
    if (firstIdx >= 0 && firstIdx < input.k) hitsAtK += 1;
    else {
      failures.push(
        `golden '${g.query}' → top-${input.k} [${ranked
          .slice(0, input.k)
          .map((r) => r.id)
          .join(", ")}], expected one of [${g.relevant_ids.join(", ")}]`,
      );
    }
    if (firstIdx >= 0) mrrSum += 1 / (firstIdx + 1);
    const found = ranked[firstIdx];
    if (found?.content) {
      const passage = bestPassage(found.content, g.query);
      const terms = queryTerms(g.query).filter((term) =>
        (found.content ?? "").toLowerCase().includes(term),
      );
      if (passage.length === 0 || passage.length > 300) {
        failures.push(`golden '${g.query}' → passage of '${found.id}' has ${passage.length} chars`);
      } else if (terms.length > 0 && !terms.some((term) => passage.toLowerCase().includes(term))) {
        failures.push(
          `golden '${g.query}' → passage of '${found.id}' shows none of the query words`,
        );
      }
    }
  }
  const recallAtK = hitsAtK / input.golden.length;
  const mrr = mrrSum / input.golden.length;

  const abstentionCeiling = input.abstention_max_cosine ?? VECTOR_MIN_COSINE;
  for (const a of input.abstention) {
    const [top] = vectorRanking(input.corpus, a.vector as number[], abstentionCeiling);
    if (top) {
      failures.push(
        `abstention '${a.query}' → '${top.entry.id}' scored ${top.score.toFixed(3)} ≥ ceiling ${abstentionCeiling} (out-of-domain must stay out of the top results)`,
      );
    }
  }

  if (recallAtK < input.min_recall_at_k) {
    failures.unshift(`recall@${input.k}=${recallAtK.toFixed(2)} < ${input.min_recall_at_k}`);
  }
  if (mrr < input.min_mrr) {
    failures.unshift(`MRR=${mrr.toFixed(2)} < ${input.min_mrr}`);
  }

  if (failures.length > 0) {
    return { pass: false, reason: failures.join(" | ") };
  }
  return { pass: true };
}
