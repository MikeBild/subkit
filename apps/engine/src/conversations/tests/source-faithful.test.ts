// source_faithful anti-drift check.
//
// Two layers under test:
//   - Pure deterministic helpers (no DB, no LLM): quote extraction and
//     quote-vs-excerpt fidelity.
//   - `checkSourceFaithful` against a real Postgres: id resolution, the
//     no-envelope no-op skip, and the judge escalation for free-text
//     paraphrase faithfulness (LLM via the in-process mock provider).
//
// LLM provider is the in-process mock (`LLM_PROVIDER=mock` set by this
// isolated test); the judge flow is steered via
// `getMockProvider().generateOverrides.judge` — no network, deterministic.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { knowledgeChunks, knowledgeSources, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import type { Citation } from "../citations.ts";
import {
  checkSourceFaithful,
  extractQuotedSpans,
  findUngroundedQuotes,
  keepResolvableCitations,
} from "../source-faithful.ts";

const skip = process.env.REQUIRES_PG === "0";

const cite = (over: Partial<Citation> & { id: string }): Citation => ({
  source_type: "knowledge_chunk",
  ...over,
});

describe("extractQuotedSpans (pure)", () => {
  test("pulls straight and curly double-quoted spans, deduped", () => {
    const spans = extractQuotedSpans(
      'The source says "Idempotency-Key header is required" and again “Idempotency-Key header is required”.',
    );
    expect(spans).toEqual(["Idempotency-Key header is required"]);
  });

  test("drops sub-8-char spans and ignores single quotes / apostrophes", () => {
    expect(extractQuotedSpans('it said "ok" — don\'t worry')).toEqual([]);
  });
});

describe("findUngroundedQuotes (pure)", () => {
  const citations: Citation[] = [
    cite({ id: "k1", excerpt: "All payments must include an Idempotency-Key header." }),
  ];

  test("a quote present in a cited excerpt is grounded (none returned)", () => {
    expect(
      findUngroundedQuotes('The guide states "include an Idempotency-Key header".', citations),
    ).toEqual([]);
  });

  test("a quote in NO cited excerpt is flagged as ungrounded", () => {
    const out = findUngroundedQuotes('It also requires "a 7-day retention window".', citations);
    expect(out).toEqual(["a 7-day retention window"]);
  });

  test("a quote longer than the longest excerpt is deferred, not failed", () => {
    const longQuote = `"${"x".repeat(300)}"`;
    expect(findUngroundedQuotes(longQuote, citations)).toEqual([]);
  });

  test("no excerpts at all → nothing to check against (empty)", () => {
    expect(findUngroundedQuotes('says "something specific here"', [cite({ id: "k1" })])).toEqual(
      [],
    );
  });
});

// ---- DB-backed: checkSourceFaithful -----------------------------------------

let testDb: TestDb;
let tenantId: string;
let resolvableChunkId: string;
let previousLlmProvider: string | undefined;

beforeAll(async () => {
  if (skip) return;
  previousLlmProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  testDb = await createTestDb("source-faithful");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-source-faithful", display_name: "Source Faithful" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;

  const [source] = await testDb.db
    .insert(knowledgeSources)
    .values({
      tenant_id: tenantId,
      name: "Compliance Policy",
      slug: "compliance-policy",
      source_type: "inline",
      source_uri: "inline://compliance",
      version: "v1",
    })
    .returning();
  if (!source) throw new Error("seed source failed");

  const [chunk] = await testDb.db
    .insert(knowledgeChunks)
    .values({
      tenant_id: tenantId,
      knowledge_source_id: source.id,
      ordinal: 0,
      content: "All payments must include an Idempotency-Key header. Retain logs for 7 years.",
      byte_size: 80,
      fingerprint: "fp-0",
    })
    .returning();
  if (!chunk) throw new Error("seed chunk failed");
  resolvableChunkId = chunk.id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
  resetMockProvider();
  if (previousLlmProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = previousLlmProvider;
}, 30_000);

describe.skipIf(skip)("keepResolvableCitations", () => {
  test("drops citations whose id does not resolve, keeps the ones that do", async () => {
    const fabricated = "00000000-0000-0000-0000-000000000000";
    const kept = await keepResolvableCitations(
      [
        cite({ id: resolvableChunkId, source_name: "Compliance Policy" }),
        cite({ id: fabricated, source_name: "Ghost Source" }),
      ],
      tenantId,
      testDb.db,
    );
    expect(kept.map((c) => c.id)).toEqual([resolvableChunkId]);
  });

  test("a wrong-tenant chunk id does not resolve (tenant isolation)", async () => {
    const kept = await keepResolvableCitations(
      [cite({ id: resolvableChunkId })],
      "11111111-1111-1111-1111-111111111111",
      testDb.db,
    );
    expect(kept).toEqual([]);
  });

  test("empty in → empty out (no query)", async () => {
    expect(await keepResolvableCitations([], tenantId, testDb.db)).toEqual([]);
  });
});

describe.skipIf(skip)("checkSourceFaithful", () => {
  test("no envelope → no-op pass (the prove-before gate's job, not this one)", async () => {
    const v = await checkSourceFaithful({
      text: "Here is a direct answer with no source.",
      citations: [],
      tenant_id: tenantId,
      db: testDb.db,
    });
    expect(v.verdict).toBe("pass");
    expect(v.reason).toContain("no citation envelope");
    expect(v.checks.ids_resolve).toBe(true);
  });

  test("envelope present + faithful prose → pass (judge confirms)", async () => {
    getMockProvider().generateOverrides.judge = () => "faithful";
    const v = await checkSourceFaithful({
      text: "Payments must carry an Idempotency-Key header, per the compliance policy.",
      citations: [
        cite({
          id: resolvableChunkId,
          source_name: "Compliance Policy",
          excerpt: "All payments must include an Idempotency-Key header.",
        }),
      ],
      tenant_id: tenantId,
      db: testDb.db,
    });
    expect(v.verdict).toBe("pass");
    expect(v.checks.ids_resolve).toBe(true);
    expect(v.checks.quotes_grounded).toBe(true);
    expect(v.checks.paraphrase_faithful).toBe(true);
    delete getMockProvider().generateOverrides.judge;
  });

  test("cited id does not resolve → fail/abstain (fabricated provenance)", async () => {
    const v = await checkSourceFaithful({
      text: "Per the policy, payments need an Idempotency-Key header.",
      citations: [cite({ id: "99999999-9999-9999-9999-999999999999", excerpt: "anything" })],
      tenant_id: tenantId,
      db: testDb.db,
    });
    expect(v.verdict).toBe("fail");
    expect(v.confidence).toBeLessThan(0.6);
    expect(v.checks.ids_resolve).toBe(false);
    expect(v.detail).toContain("unresolved");
  });

  test("a fabricated connector_doc id is flagged unresolved (the provenance-hole guard)", async () => {
    // Before connector_doc citations got their own resolve query, a
    // connector_doc id was DROPPED from the filter → silently exempt →
    // a fabricated one passed the gate. It must now fail like a bogus
    // knowledge_chunk id does.
    const v = await checkSourceFaithful({
      text: "Per the connector docs, charges use POST /v1/charges.",
      citations: [
        cite({
          id: "88888888-8888-8888-8888-888888888888",
          source_type: "connector_doc",
          excerpt: "anything",
        }),
      ],
      tenant_id: tenantId,
      db: testDb.db,
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks.ids_resolve).toBe(false);
    expect(v.detail).toContain("unresolved");
  });

  test("a malformed (non-UUID) cited id never resolves → fail without a DB cast error", async () => {
    const v = await checkSourceFaithful({
      text: "Per the policy, payments need an Idempotency-Key header.",
      citations: [cite({ id: "not-a-uuid", excerpt: "anything" })],
      tenant_id: tenantId,
      db: testDb.db,
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks.ids_resolve).toBe(false);
  });

  test("claimed quote absent from the cited excerpt → fail (fabricated quote)", async () => {
    const v = await checkSourceFaithful({
      text: 'The policy says "logs must be encrypted at rest".',
      citations: [
        cite({
          id: resolvableChunkId,
          excerpt: "All payments must include an Idempotency-Key header.",
        }),
      ],
      tenant_id: tenantId,
      db: testDb.db,
    });
    expect(v.verdict).toBe("fail");
    expect(v.confidence).toBeLessThan(0.6);
    expect(v.checks.quotes_grounded).toBe(false);
    expect(v.detail).toContain("ungrounded quote");
  });

  test("free-text-only claim escalates to the judge → judge 'drift' fails", async () => {
    getMockProvider().generateOverrides.judge = () => "drift";
    const v = await checkSourceFaithful({
      // No verbatim quote, resolvable id → deterministic checks pass, so the
      // free-text faithfulness call is the ONLY thing that can fail it.
      text: "The compliance policy requires SOC 2 certification for all vendors.",
      citations: [
        cite({
          id: resolvableChunkId,
          excerpt: "All payments must include an Idempotency-Key header.",
        }),
      ],
      tenant_id: tenantId,
      db: testDb.db,
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks.ids_resolve).toBe(true);
    expect(v.checks.quotes_grounded).toBe(true);
    expect(v.checks.paraphrase_faithful).toBe(false);
    delete getMockProvider().generateOverrides.judge;
  });

  test("judge unavailable (unparseable verdict) → treated as pass, never blocks on infra", async () => {
    getMockProvider().generateOverrides.judge = () => ({ shape: "unexpected" });
    const v = await checkSourceFaithful({
      text: "The compliance policy covers payment idempotency.",
      citations: [
        cite({
          id: resolvableChunkId,
          excerpt: "All payments must include an Idempotency-Key header.",
        }),
      ],
      tenant_id: tenantId,
      db: testDb.db,
    });
    expect(v.verdict).toBe("pass");
    expect(v.checks.ids_resolve).toBe(true);
    expect(v.checks.quotes_grounded).toBe(true);
    expect(v.checks.paraphrase_faithful).toBeUndefined();
    delete getMockProvider().generateOverrides.judge;
  });
});
