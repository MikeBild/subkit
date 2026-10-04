import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import * as invokeModule from "../../llm/core/invoke.ts";
import { LlmProviderError, LlmQuotaExhausted } from "../../llm/errors.ts";
import { getKnowledgeSource } from "../catalog.ts";
import {
  analyzeKnowledgeSource,
  createKnowledgeSource,
  updateKnowledgeSource,
} from "../service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

const skip = process.env.REQUIRES_PG === "0";

let ctx: KnowledgeTestCtx;

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
      expect(enriched!.name).toBe(source.name);
      expect(enriched!.slug).toBe(source.slug);

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
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: {
          name: "Domain Tagged Doc",
          scope: "global",
          tags: ["domain:harmoniqs", "old-note"],
        },
        upload: {
          buffer: Buffer.from("# Harmony\n\nCircle of fifths and scale chords."),
          filename: "harmony.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(source.tags).toEqual(["domain:harmoniqs", "old-note"]);

    const spy = spyOn(invokeModule, "invoke").mockResolvedValue(
      makeInvokeResult({
        description: "Fundamentals of harmony.",
        tags: ["music-theory", "chords"],
      }),
    );
    try {
      const enriched = await analyzeKnowledgeSource(
        { tenant_id: ctx.tenantId, id: source.id, actor_id: null, force: true },
        ctx.testDb.db,
      );
      expect(enriched!.tags).toEqual(["domain:harmoniqs", "music-theory", "chords"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("only name-shaped namespace prefixes are structural — and analysis mints no routing keys", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: {
          name: "Colon Tagged Doc",
          scope: "global",
          tags: ["domain:harmoniqs", "café:paris", "note: x", "note about: chords", "q&a:faq"],
        },
        upload: {
          buffer: Buffer.from("# Chords\n\nScale chords in a major key."),
          filename: "chords.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const spy = spyOn(invokeModule, "invoke").mockResolvedValue(
      makeInvokeResult({
        description: "Chord theory.",
        tags: ["chords", "domain:evil"],
      }),
    );
    try {
      const enriched = await analyzeKnowledgeSource(
        { tenant_id: ctx.tenantId, id: source.id, actor_id: null, force: true },
        ctx.testDb.db,
      );
      expect(enriched!.tags).toEqual(["domain:harmoniqs", "café:paris", "chords"]);
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
          tags: ["domain:harmoniqs", "music-theory"],
        },
        upload: {
          buffer: Buffer.from("# Relocation\n\nThis source changes domain."),
          filename: "relocation.md",
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
        patch: { tags: ["domain:blog-de", "music-theory"] },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(patched!.tags).toEqual(["domain:blog-de", "music-theory"]);
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

      expect(result!.description).toBe("Original human description.");
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

    const result = await analyzeKnowledgeSource(
      { tenant_id: crypto.randomUUID(), id: source.id, actor_id: null }, // allow-random: deliberate wrong-tenant test
      ctx.testDb.db,
    );
    expect(result).toBeNull();
  });

  test("source with no chunks is a no-op (returns view unchanged, invoke not called)", async () => {
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

      expect(result).not.toBeNull();
      expect(result!.id).toBe(source.id);
      expect(result!.description).toBeNull();
      expect(result!.tags).toEqual([]);

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
      const first = await analyzeKnowledgeSource(
        { tenant_id: ctx.tenantId, id: source.id, actor_id: null, force: true },
        ctx.testDb.db,
      );
      expect(first!.tags).toEqual(["api", "rest", "users"]);

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
