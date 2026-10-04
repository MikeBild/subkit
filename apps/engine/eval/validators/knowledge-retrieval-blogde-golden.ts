import { cosineSimilarity, EMBEDDING_MODEL } from "../../src/embeddings/local-provider.ts";
import { VECTOR_MIN_COSINE } from "../../src/embeddings/vector-rerank.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  k: number;
  min_recall_at_k: number;
  min_mrr: number;
  abstention_max_cosine?: number;
  embedding_model?: string;
  corpus: Array<{ id: string; vector?: number[] }>;
  golden: Array<{ query: string; relevant_ids: string[]; vector?: number[] }>;
  abstention: Array<{ query: string; vector?: number[] }>;
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

  const rank = (queryVec: number[]): Array<{ id: string; score: number }> =>
    input.corpus
      .map((c) => ({ id: c.id, score: cosineSimilarity(queryVec, c.vector as number[]) }))
      .sort((a, b) => b.score - a.score);

  const failures: string[] = [];
  let hitsAtK = 0;
  let mrrSum = 0;
  for (const g of input.golden) {
    const ranked = rank(g.vector as number[]);
    const relevant = new Set(g.relevant_ids);
    const firstIdx = ranked.findIndex((r) => relevant.has(r.id));
    if (firstIdx >= 0 && firstIdx < input.k) hitsAtK += 1;
    else {
      failures.push(
        `golden '${g.query}' → top-${input.k} [${ranked
          .slice(0, input.k)
          .map((r) => `${r.id}:${r.score.toFixed(2)}`)
          .join(", ")}], expected one of [${g.relevant_ids.join(", ")}]`,
      );
    }
    if (firstIdx >= 0) mrrSum += 1 / (firstIdx + 1);
  }
  const recallAtK = hitsAtK / input.golden.length;
  const mrr = mrrSum / input.golden.length;

  const abstentionCeiling = input.abstention_max_cosine ?? VECTOR_MIN_COSINE;
  for (const a of input.abstention) {
    const [top] = rank(a.vector as number[]);
    if (top && top.score >= abstentionCeiling) {
      failures.push(
        `abstention '${a.query}' → '${top.id}' scored ${top.score.toFixed(3)} ≥ ceiling ${abstentionCeiling} (out-of-domain must stay out of the top results)`,
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
