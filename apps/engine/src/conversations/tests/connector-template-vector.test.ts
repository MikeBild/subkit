// Hybrid connector-template ranking — fusion logic, deterministic.
//
// The real model's quality is proven by benchmarks/retrieval; here we pin
// the FUSION RULE (the part that can regress) with a stub embedder, so no
// model download is needed:
//   - exact vendor match overrides the vector ranking
//   - a non-exact intent query is ranked by cosine similarity
//   - embeddings unavailable → degrade to the pure lexical scorer

import { describe, expect, test } from "bun:test";

import { loadBuiltinTemplates } from "../../connectors/templates.ts";
import { suggestConnectorTemplates } from "../connector-template-intelligence.ts";
import {
  type HybridEmbedder,
  suggestConnectorTemplatesHybrid,
  templateEmbeddingText,
} from "../connector-template-vector.ts";

const ALL = loadBuiltinTemplates();
const stripe = ALL.find((t) => t.slug === "stripe")!;
const github = ALL.find((t) => t.slug === "github")!;
const templates = [stripe, github];

/** Stub embedder: returns the vector mapped to each exact text, else a
 *  zero-ish orthogonal vector. Cosine is computed by the real helper. */
function stub(mapping: Record<string, number[]>): HybridEmbedder {
  return {
    available: async () => true,
    embed: async (texts) => texts.map((t) => mapping[t] ?? [0, 0, 1]),
  };
}

describe("suggestConnectorTemplatesHybrid — fusion", () => {
  test("non-exact intent is ranked by vector similarity", async () => {
    // Query embeds close to Stripe, far from GitHub.
    const embedder = stub({
      "take a payment from a customer": [1, 0, 0],
      [templateEmbeddingText(stripe)]: [1, 0, 0],
      [templateEmbeddingText(github)]: [0, 1, 0],
    });
    const out = await suggestConnectorTemplatesHybrid(
      { query: "take a payment from a customer", limit: 2, templates },
      embedder,
    );
    expect(out[0]?.template.slug).toBe("stripe");
  });

  test("exact vendor match overrides the vector ranking", async () => {
    // Even though the stub would rank Stripe top for the GitHub query,
    // the exact name match on 'github' must win.
    const embedder = stub({
      github: [1, 0, 0],
      [templateEmbeddingText(stripe)]: [1, 0, 0],
      [templateEmbeddingText(github)]: [0, 1, 0],
    });
    const out = await suggestConnectorTemplatesHybrid(
      { query: "github", limit: 2, templates },
      embedder,
    );
    expect(out[0]?.template.slug).toBe("github");
  });

  test("embeddings unavailable → degrades to the lexical scorer", async () => {
    const offline: HybridEmbedder = { available: async () => false, embed: async () => [] };
    const out = await suggestConnectorTemplatesHybrid(
      { query: "github", limit: 2, templates },
      offline,
    );
    const lexical = suggestConnectorTemplates({ query: "github", limit: 2, templates });
    expect(out.map((r) => r.template.slug)).toEqual(lexical.map((r) => r.template.slug));
  });
});
