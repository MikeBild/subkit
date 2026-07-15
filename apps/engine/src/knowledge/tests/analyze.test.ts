// analyzeKnowledgeSource — integration tests.
//
// The LLM call is intercepted via spyOn on the invoke module so no real
// model is contacted and the test controls exactly what the "model"
// returns or throws. Each test resets the spy before/after so sibling
// files are unaffected.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import * as invokeModule from "../../llm/core/invoke.ts";
import { LlmProviderError, LlmQuotaExhausted } from "../../llm/errors.ts";
import {
  analyzeKnowledgeSource,
  createKnowledgeSource,
  getKnowledgeSource,
  updateKnowledgeSource,
} from "../service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

// Requires a real Postgres database — set REQUIRES_PG=0 to skip.
const skip = process.env.REQUIRES_PG === "0";

let ctx: KnowledgeTestCtx;

// A minimal InvokeResult shape analyzeKnowledgeSource reads from.
function makeInvokeResult(object: unknown) {
  return {
    object,
    text: JSON.stringify(object),
    model_used: "test-model",
    fell_back: false,
    route: {} as never,
    assembled: {} as never,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
  };
}

beforeAll(async () => {
  if (skip) return;
  ctx = await createKnowledgeTestCtx("analyze");
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

// Reset any spy installed by an individual test so sibling tests stay clean.
afterEach(() => {
  if (skip) return;
});

describe.skipIf(skip)("knowledge/analyzeKnowledgeSource", () => {
  test("sets description and tags when both are absent; writes audit row", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Untagged Doc", scope: "global" },
        upload: {
          buffer: Buffer.from(
            "# Security Policy\n\nAll API access requires OAuth2 bearer tokens.\n\n## Logging\n\nAudit logs retained for 90 days.",
          ),
          filename: "security.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    expect(source.description).toBeNull();
    expect(source.tags).toEqual([]);

    const spy = spyOn(invokeModule, "invoke").mockResolvedValue(
      makeInvokeResult({
        description: "Security and access policy.",
        tags: ["security", "oauth2", "logging"],
      }),
    );

    try {
      const enriched = await analyzeKnowledgeSource(
        { tenant_id: ctx.tenantId, id: source.id, actor_id: null },
        ctx.testDb.db,
      );

      expect(enriched).not.toBeNull();
      expect(enriched!.description).toBe("Security and access policy.");
      expect(enriched!.tags).toEqual(["security", "oauth2", "logging"]);
      // name and slug must not change
      expect(enriched!.name).toBe(source.name);
      expect(enriched!.slug).toBe(source.slug);

      // Audit entry written
      const audits = await ctx.testDb.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, source.id));
      expect(audits.some((a) => a.action === "knowledge_source.analyzed")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("preserves namespaced tags (domain:*) and replaces only topical tags", async () => {
    // Regression: analysis used to REPLACE the whole tag set, silently
    // dropping `domain:<slug>` — the source vanished from its domain
    // briefing and tag-filtered search until the operator re-tagged it.
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: {
          name: "Domain Tagged Doc",
          scope: "global",
          tags: ["domain:harmoniqs", "alte-notiz"],
        },
        upload: {
          buffer: Buffer.from("# Harmonielehre\n\nQuintenzirkel und Stufenakkorde."),
          filename: "harmonie.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(source.tags).toEqual(["domain:harmoniqs", "alte-notiz"]);

    const spy = spyOn(invokeModule, "invoke").mockResolvedValue(
      makeInvokeResult({
        description: "Grundlagen der Harmonielehre.",
        tags: ["musiktheorie", "akkorde"],
      }),
    );
    try {
      const enriched = await analyzeKnowledgeSource(
        { tenant_id: ctx.tenantId, id: source.id, actor_id: null, force: true },
        ctx.testDb.db,
      );
      expect(enriched!.tags).toEqual(["domain:harmoniqs", "musiktheorie", "akkorde"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("prose colons are topical, non-ASCII namespaces structural — and analysis mints no routing keys", async () => {
    // `isStructuralTag`: whitespace-free prefix + colon + content directly
    // after. Prose colons ("note: x", "note about: chords") must not pin a
    // tag forever; a non-ASCII namespace (`domäne:blog`) stays structural.
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: {
          name: "Colon Tagged Doc",
          scope: "global",
          tags: ["domain:harmoniqs", "domäne:blog", "note: x", "note about: chords", "q&a:faq"],
        },
        upload: {
          buffer: Buffer.from("# Akkorde\n\nStufenakkorde in Dur."),
          filename: "akkorde.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const spy = spyOn(invokeModule, "invoke").mockResolvedValue(
      makeInvokeResult({
        description: "Akkordlehre.",
        // `domain:evil` is structural-shaped model output — analysis must
        // never mint a routing key, only replace topical tags.
        tags: ["akkorde", "domain:evil"],
      }),
    );
    try {
      const enriched = await analyzeKnowledgeSource(
        { tenant_id: ctx.tenantId, id: source.id, actor_id: null, force: true },
        ctx.testDb.db,
      );
      expect(enriched!.tags).toEqual(["domain:harmoniqs", "domäne:blog", "akkorde"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("an explicit tags PATCH replaces wholesale — the one way to re-home a source", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: {
          name: "Re-homed Doc",
          scope: "global",
          tags: ["domain:harmoniqs", "musiktheorie"],
        },
        upload: {
          buffer: Buffer.from("# Umzug\n\nDiese Quelle wechselt die Domäne."),
          filename: "umzug.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const patched = await updateKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        id: source.id,
        patch: { tags: ["domain:blog-de", "musiktheorie"] },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(patched!.tags).toEqual(["domain:blog-de", "musiktheorie"]);
  });

  test("does NOT overwrite an existing description unless force is set", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: {
          name: "Existing Desc Doc",
          description: "Original human description.",
          scope: "global",
        },
        upload: {
          buffer: Buffer.from(
            "# Guide\n\nThis is a guide for operators.\n\n## Setup\n\nInstall the CLI first.",
          ),
          filename: "guide.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    expect(source.description).toBe("Original human description.");

    const spy = spyOn(invokeModule, "invoke").mockResolvedValue(
      makeInvokeResult({
        description: "LLM-generated description.",
        tags: ["guide", "cli", "setup"],
      }),
    );

    try {
      const result = await analyzeKnowledgeSource(
        { tenant_id: ctx.tenantId, id: source.id, actor_id: null },
        ctx.testDb.db,
      );

      // Description must be preserved — force was not passed
      expect(result!.description).toBe("Original human description.");
      // Tags should be updated
      expect(result!.tags).toEqual(["guide", "cli", "setup"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("force:true overwrites an existing description", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: {
          name: "Force Overwrite Doc",
          description: "Stale description.",
          scope: "global",
        },
        upload: {
          buffer: Buffer.from(
            "# Compliance\n\nMust comply with GDPR and SOC2.\n\n## Retention\n\nData retained 7 years.",
          ),
          filename: "compliance.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    const spy = spyOn(invokeModule, "invoke").mockResolvedValue(
      makeInvokeResult({
        description: "GDPR and SOC2 compliance guide.",
        tags: ["compliance", "gdpr", "soc2"],
      }),
    );

    try {
      const result = await analyzeKnowledgeSource(
        { tenant_id: ctx.tenantId, id: source.id, actor_id: null, force: true },
        ctx.testDb.db,
      );

      expect(result!.description).toBe("GDPR and SOC2 compliance guide.");
      expect(result!.tags).toEqual(["compliance", "gdpr", "soc2"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("never changes name or slug", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Stable Name Doc", slug: "stable-name-doc", scope: "global" },
        upload: {
          buffer: Buffer.from("# Stable\n\nThis source has a fixed name and slug."),
          filename: "stable.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    const spy = spyOn(invokeModule, "invoke").mockResolvedValue(
      makeInvokeResult({ description: "Stable doc.", tags: ["stable", "naming", "policy"] }),
    );

    try {
      const result = await analyzeKnowledgeSource(
        { tenant_id: ctx.tenantId, id: source.id, actor_id: null },
        ctx.testDb.db,
      );

      expect(result!.name).toBe("Stable Name Doc");
      expect(result!.slug).toBe("stable-name-doc");
    } finally {
      spy.mockRestore();
    }
  });

  test("returns null for a non-existent id", async () => {
    const result = await analyzeKnowledgeSource(
      { tenant_id: ctx.tenantId, id: crypto.randomUUID(), actor_id: null }, // allow-random: deliberate missing-id test
      ctx.testDb.db,
    );
    expect(result).toBeNull();
  });

  test("returns null for a valid id belonging to a different tenant", async () => {
    // Create a source under the real tenant
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Cross Tenant Doc", scope: "global" },
        upload: {
          buffer: Buffer.from("Content that should not cross tenants."),
          filename: "cross.txt",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    // Attempt to analyze it as a different (random) tenant
    const result = await analyzeKnowledgeSource(
      { tenant_id: crypto.randomUUID(), id: source.id, actor_id: null }, // allow-random: deliberate wrong-tenant test
      ctx.testDb.db,
    );
    expect(result).toBeNull();
  });

  test("source with no chunks is a no-op (returns view unchanged, invoke not called)", async () => {
    // Create a source with empty content so chunk_count = 0
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "No Chunks Doc", scope: "global" },
        upload: {
          buffer: Buffer.from(""),
          filename: "empty.txt",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    expect(source.chunk_count).toBe(0);

    const spy = spyOn(invokeModule, "invoke").mockResolvedValue(
      makeInvokeResult({ description: "Should not be called.", tags: ["nope"] }),
    );

    try {
      const result = await analyzeKnowledgeSource(
        { tenant_id: ctx.tenantId, id: source.id, actor_id: null },
        ctx.testDb.db,
      );

      // Returns the view unchanged
      expect(result).not.toBeNull();
      expect(result!.id).toBe(source.id);
      expect(result!.description).toBeNull();
      expect(result!.tags).toEqual([]);

      // invoke must NOT have been called (no chunks → no LLM call)
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("when invoke throws, analyzeKnowledgeSource propagates and the row is unchanged", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Error Case Doc", scope: "global" },
        upload: {
          buffer: Buffer.from(
            "# Runbook\n\nFix the database when it breaks.\n\n## Steps\n\nRestart the service.",
          ),
          filename: "runbook.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    const spy = spyOn(invokeModule, "invoke").mockRejectedValue(
      new LlmProviderError("other", "mock provider error"),
    );

    try {
      await expect(
        analyzeKnowledgeSource(
          { tenant_id: ctx.tenantId, id: source.id, actor_id: null },
          ctx.testDb.db,
        ),
      ).rejects.toThrow();

      // Row must be unchanged
      const row = await getKnowledgeSource(ctx.tenantId, source.id, ctx.testDb.db);
      expect(row!.description).toBeNull();
      expect(row!.tags).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test("when invoke throws LlmQuotaExhausted, analyzeKnowledgeSource propagates", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Quota Case Doc", scope: "global" },
        upload: {
          buffer: Buffer.from(
            "# Budget\n\nThis tests quota exhaustion propagation.\n\n## Notes\n\nCallers must swallow.",
          ),
          filename: "budget.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    const spy = spyOn(invokeModule, "invoke").mockRejectedValue(
      new LlmQuotaExhausted("tenant monthly token budget exhausted"),
    );

    try {
      await expect(
        analyzeKnowledgeSource(
          { tenant_id: ctx.tenantId, id: source.id, actor_id: null },
          ctx.testDb.db,
        ),
      ).rejects.toBeInstanceOf(LlmQuotaExhausted);

      // Row must be unchanged — callers at interactive sites swallow this
      const row = await getKnowledgeSource(ctx.tenantId, source.id, ctx.testDb.db);
      expect(row!.description).toBeNull();
      expect(row!.tags).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test("re-analyzing a source twice with the same tags does NOT double tags (replace semantics)", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Dedupe Tags Doc", scope: "global" },
        upload: {
          buffer: Buffer.from(
            "# API\n\nREST endpoints for managing users and billing.\n\n## Users\n\nCRUD operations.",
          ),
          filename: "api.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    const spy = spyOn(invokeModule, "invoke").mockResolvedValue(
      makeInvokeResult({ description: "API reference doc.", tags: ["api", "rest", "users"] }),
    );

    try {
      // First analysis
      const first = await analyzeKnowledgeSource(
        { tenant_id: ctx.tenantId, id: source.id, actor_id: null, force: true },
        ctx.testDb.db,
      );
      expect(first!.tags).toEqual(["api", "rest", "users"]);

      // Second analysis with same tags — must replace, not concat
      const second = await analyzeKnowledgeSource(
        { tenant_id: ctx.tenantId, id: source.id, actor_id: null, force: true },
        ctx.testDb.db,
      );
      expect(second!.tags).toEqual(["api", "rest", "users"]);
      expect(second!.tags.length).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });
});
