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

function stub(mapping: Record<string, number[]>): HybridEmbedder {
  return {
    available: async () => true,
    embed: async (texts) => texts.map((t) => mapping[t] ?? [0, 0, 1]),
  };
}

describe("suggestConnectorTemplatesHybrid — fusion", () => {
  test("non-exact intent is ranked by vector similarity", async () => {
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
