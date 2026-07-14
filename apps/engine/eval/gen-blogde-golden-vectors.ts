// Generator for the blog-de retrieval golden set's pinned vectors.
//
// The eval gate runs under plain `bun run`, where the engine's embedded
// onnxruntime WASM deliberately does not load (compiled-binary-only —
// see embeddings/embedded-assets.ts). So the golden set pins the REAL
// MiniLM geometry instead: this script embeds the fixture's corpus and
// queries with the same model/dtype/pooling the engine uses
// (Xenova/paraphrase-multilingual-MiniLM-L12-v2, q8, mean+normalize)
// and writes them into the fixture. The validator is then pure cosine
// math — deterministic and model-load-free.
//
// Re-run whenever the fixture's texts change or the engine's
// EMBEDDING_MODEL moves (the validator pins the model name and fails
// loudly on drift):
//
//   bun run apps/engine/eval/gen-blogde-golden-vectors.ts && bun run lint:fix

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDING_MODEL } from "../src/embeddings/local-provider.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "knowledge-retrieval-blogde-golden.json");

interface Fixture {
  input: {
    embedding_model?: string;
    corpus: Array<{ id: string; title: string; content: string; vector?: number[] }>;
    golden: Array<{ query: string; relevant_ids: string[]; vector?: number[] }>;
    abstention: Array<{ query: string; vector?: number[] }>;
  };
  [k: string]: unknown;
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

const { pipeline } = await import("@huggingface/transformers");
const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" });

async function embed(texts: string[]): Promise<number[][]> {
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  const data = out.data as Float32Array;
  const dim = (out.dims as number[])[1] ?? 384;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(Array.from(data.slice(i * dim, (i + 1) * dim), (v) => Number(v.toFixed(6))));
  }
  return vectors;
}

const corpusVecs = await embed(fixture.input.corpus.map((c) => `${c.title}\n${c.content}`));
fixture.input.corpus.forEach((c, i) => {
  c.vector = corpusVecs[i];
});
const goldenVecs = await embed(fixture.input.golden.map((g) => g.query));
fixture.input.golden.forEach((g, i) => {
  g.vector = goldenVecs[i];
});
const abstentionVecs = await embed(fixture.input.abstention.map((a) => a.query));
fixture.input.abstention.forEach((a, i) => {
  a.vector = abstentionVecs[i];
});
fixture.input.embedding_model = EMBEDDING_MODEL;

writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  `wrote ${fixture.input.corpus.length} corpus + ${fixture.input.golden.length} golden + ${fixture.input.abstention.length} abstention vectors (${EMBEDDING_MODEL})`,
);
