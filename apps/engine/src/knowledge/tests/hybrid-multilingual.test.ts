// Hybrid retrieval — multilingual recovery, end-to-end.
//
// Proves the core Track-B win for the knowledge path: a GERMAN query
// retrieves an ENGLISH chunk that shares no English stem, which the
// FTS-only path (plainto_tsquery('english', …)) provably cannot match.
//
// Needs Postgres AND the local embedding model, so it is opt-in: set
// RUN_EMBEDDING_E2E=1 (and a DB) to run. CI skips it to avoid a model
// download; the fusion logic itself is covered deterministically in
// embeddings/tests/vector-rerank.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { backfillEmbeddings } from "../../embeddings/backfill.ts";
import { embeddingsAvailable } from "../../embeddings/local-provider.ts";
import { createKnowledgeSource, searchKnowledge } from "../service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

const skip = process.env.REQUIRES_PG === "0" || process.env.RUN_EMBEDDING_E2E !== "1";

let ctx: KnowledgeTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createKnowledgeTestCtx("hybrid-ml");
  await createKnowledgeSource(
    {
      tenant_id: ctx.tenantId,
      input: { name: "Payments Guide", scope: "global" },
      upload: {
        buffer: Buffer.from(
          "# Payments\n\nUse the charges endpoint to take a payment from a customer's " +
            "credit card. Refunds return money to the buyer. Invoices bill a customer " +
            "for a subscription.\n\n# Repositories\n\nList pull requests and commits on a " +
            "code repository.",
        ),
        filename: "payments.md",
        mime: "text/markdown",
      },
      actor_id: null,
    },
    ctx.testDb.db,
  );
  // Embeddings are populated out-of-band (ingest stays fast) — run the
  // backfill explicitly so the vector path has data to recover against.
  await backfillEmbeddings({ tenant_id: ctx.tenantId }, ctx.testDb.db);
}, 120_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("knowledge/hybrid multilingual recovery", () => {
  test("the model is available for this opt-in run", async () => {
    expect(await embeddingsAvailable()).toBe(true);
  });

  test("a German query retrieves the English payments chunk (FTS would miss)", async () => {
    // 'Kartenzahlung von einem Kunden entgegennehmen' shares no English
    // stem with the content → plainto_tsquery('english') matches nothing.
    const hits = await searchKnowledge(
      {
        tenant_id: ctx.tenantId,
        query: "Kartenzahlung von einem Kunden entgegennehmen",
      },
      ctx.testDb.db,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet.toLowerCase()).toContain("payment");
  });

  test("German repo intent retrieves the repositories chunk, not payments", async () => {
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "Pull Requests in einem Code-Repository auflisten" },
      ctx.testDb.db,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet.toLowerCase()).toContain("repositor");
  });
});
