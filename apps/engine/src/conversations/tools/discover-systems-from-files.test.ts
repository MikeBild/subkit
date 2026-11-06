import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { tenants } from "../../db/schema/identity.ts";
import {
  knowledgeChunks,
  knowledgeSources,
  knowledgeSourceVersions,
} from "../../db/schema/knowledge_sources.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { knowledgeContentHash } from "../../knowledge/version-record.ts";
import * as invokeModule from "../../llm/runtime/invoke.ts";
import {
  discoverSystemsFromFilesTool,
  KNOWLEDGE_SOURCE_MAX_CHARS,
} from "./discover-systems-from-files.ts";
import type { ToolContext } from "./index.ts";

let ctx: TestDb;
let tenant_id: string;
let other_tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("discover_systems_from_files");
  const [t1] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-dsff-a", display_name: "T A" })
    .returning();
  const [t2] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-dsff-b", display_name: "T B" })
    .returning();
  tenant_id = t1!.id;
  other_tenant_id = t2!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(async () => {
  await ctx.db.delete(auditLog);
  await ctx.db.delete(knowledgeSourceVersions);
  await ctx.db.delete(knowledgeChunks);
  await ctx.db.delete(knowledgeSources);
});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const base: ToolContext = {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
  return { ...base, ...overrides };
}

const SAMPLE_MARKDOWN = `# DigitalOcean platform

We talk to DigitalOcean to manage droplets. Auth is a Bearer token under
\`Authorization: Bearer <token>\`. Useful endpoints:

- GET /v2/droplets — list droplets
- POST /v2/droplets — create droplet
- DELETE /v2/droplets/{id} — destroy droplet
`;

async function seedSourceWithContent(t: string, content: string): Promise<string> {
  const [src] = await ctx.db
    .insert(knowledgeSources)
    .values({
      tenant_id: t,
      name: "do-readme",
      slug: `seed-source-${crypto.randomUUID()}`, // allow-random: legacy; review before changing
      scope: "global",
      status: "active",
      source_type: "file_upload",
      source_uri: "do-readme.md",
      mime_type: "text/markdown",
      version: "v1",
      bytes_total: content.length,
      chunk_count: 1,
    })
    .returning();
  await ctx.db.insert(knowledgeChunks).values({
    tenant_id: t,
    knowledge_source_id: src!.id,
    ordinal: 0,
    title: "do-readme",
    path: "do-readme.md",
    content,
    byte_size: content.length,
    fingerprint: "fp-1",
  });
  return src!.id;
}

const CANDIDATES_RESPONSE = {
  candidates: [
    {
      name: "DigitalOcean",
      kind: "http" as const,
      base_url_guess: "https://api.digitalocean.com",
      endpoints: [
        { method: "GET", path: "/v2/droplets", summary: "List droplets" },
        { method: "POST", path: "/v2/droplets", summary: "Create droplet" },
      ],
      auth_kind: "bearer" as const,
      data_flow_summary: "Tenant manages droplets via DigitalOcean's REST API.",
      data_flow_role: "bidirectional" as const,
      capabilities: ["read", "write"] as const,
    },
  ],
  potential_connections: [],
};

const TWO_SYSTEM_RESPONSE = {
  candidates: [
    {
      name: "Stripe",
      kind: "http" as const,
      base_url_guess: "https://api.stripe.com",
      endpoints: [{ method: "GET", path: "/v1/charges", summary: "List charges" }],
      auth_kind: "bearer" as const,
      data_flow_summary: "Tenant reads billing events from Stripe.",
      data_flow_role: "source" as const,
      capabilities: ["read", "webhook"] as const,
    },
    {
      name: "HubSpot",
      kind: "http" as const,
      base_url_guess: "https://api.hubapi.com",
      endpoints: [{ method: "POST", path: "/crm/v3/objects/deals", summary: "Create deal" }],
      auth_kind: "oauth2" as const,
      data_flow_summary: "Tenant pushes new deals into HubSpot CRM.",
      data_flow_role: "destination" as const,
      capabilities: ["write"] as const,
    },
  ],
  potential_connections: [
    {
      from_system: "Stripe",
      to_system: "HubSpot",
      data_type: "charges → deals",
      direction: "one_way" as const,
      evidence: "Each successful Stripe charge becomes a deal in HubSpot CRM.",
    },
  ],
};

function mockedInvokeOk(payload: unknown = CANDIDATES_RESPONSE) {
  return spyOn(invokeModule, "invoke").mockResolvedValue({
    object: payload,
    text: JSON.stringify(payload),
    model_used: "mock-model",
    fell_back: false,
    // biome-ignore lint/suspicious/noExplicitAny: route + assembled fields are not asserted by the tool
    route: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: route + assembled fields are not asserted by the tool
    assembled: {} as any,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
  });
}

describe("discover_systems_from_files — fresh call", () => {
  test("invokes LLM, persists candidates, records audit row", async () => {
    const sourceId = await seedSourceWithContent(tenant_id, SAMPLE_MARKDOWN);
    const spy = mockedInvokeOk();
    try {
      const r = await discoverSystemsFromFilesTool.execute(makeCtx(), {
        knowledge_source_id: sourceId,
      });
      expect(r.ok).toBe(true);
      const data = (
        r as {
          ok: true;
          data: {
            source: string;
            candidates: Array<{ name: string; endpoints: Array<{ path: string }> }>;
            cached_at: string;
          };
        }
      ).data;
      expect(data.source).toBe("fresh");
      expect(data.candidates).toHaveLength(1);
      expect(data.candidates[0]?.name).toBe("DigitalOcean");
      expect(data.candidates[0]?.endpoints[0]?.path).toBe("/v2/droplets");
      expect(spy).toHaveBeenCalledTimes(1);

      const candRows = await ctx.db
        .select()
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.tenant_id, tenant_id),
            eq(knowledgeSources.source_type, "connector_endpoint_candidates"),
          ),
        );
      expect(candRows).toHaveLength(1);
      expect(candRows[0]?.source_uri).toBe(sourceId);

      const candChunks = await ctx.db
        .select()
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.knowledge_source_id, candRows[0]!.id));
      expect(candChunks).toHaveLength(1);
      const stored = JSON.parse(candChunks[0]!.content) as typeof CANDIDATES_RESPONSE;
      expect(stored.candidates[0]?.name).toBe("DigitalOcean");

      const versions = await ctx.db
        .select()
        .from(knowledgeSourceVersions)
        .where(
          and(
            eq(knowledgeSourceVersions.tenant_id, tenant_id),
            eq(knowledgeSourceVersions.knowledge_source_id, candRows[0]!.id),
          ),
        );
      expect(versions).toHaveLength(1);
      expect(versions[0]?.content).toMatchObject({
        kind: "document",
        text: candChunks[0]!.content,
      });
      expect(versions[0]?.content_hash).toBe(knowledgeContentHash(candChunks[0]!.content));

      const audits = await ctx.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenant_id),
            eq(auditLog.action, "knowledge_source.candidates_synthesized"),
          ),
        );
      expect(audits).toHaveLength(1);
      expect(audits[0]?.reason).toBe("file_analysis");
      expect(audits[0]?.resource_id).toBe(candRows[0]!.id);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("discover_systems_from_files — cache hit", () => {
  test("second call within 24h returns source=cache, no LLM, no new audit row", async () => {
    const sourceId = await seedSourceWithContent(tenant_id, SAMPLE_MARKDOWN);
    const seed = mockedInvokeOk();
    await discoverSystemsFromFilesTool.execute(makeCtx(), { knowledge_source_id: sourceId });
    seed.mockRestore();

    const before = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, "knowledge_source.candidates_synthesized"),
        ),
      );
    expect(before).toHaveLength(1);

    const blocked = spyOn(invokeModule, "invoke").mockRejectedValue(
      new Error("must not be called"),
    );
    try {
      const r = await discoverSystemsFromFilesTool.execute(makeCtx(), {
        knowledge_source_id: sourceId,
      });
      expect(r.ok).toBe(true);
      const data = (r as { ok: true; data: { source: string; candidates: unknown[] } }).data;
      expect(data.source).toBe("cache");
      expect(data.candidates).toHaveLength(1);
      expect(blocked).not.toHaveBeenCalled();

      const after = await ctx.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenant_id),
            eq(auditLog.action, "knowledge_source.candidates_synthesized"),
          ),
        );
      expect(after).toHaveLength(1);
    } finally {
      blocked.mockRestore();
    }
  });
});

describe("discover_systems_from_files — connection graph", () => {
  test("returns potential_connections graph and round-trips it through cache", async () => {
    const sourceId = await seedSourceWithContent(
      tenant_id,
      "Stripe charges flow into HubSpot deals.",
    );
    const seed = mockedInvokeOk(TWO_SYSTEM_RESPONSE);
    try {
      const fresh = await discoverSystemsFromFilesTool.execute(makeCtx(), {
        knowledge_source_id: sourceId,
      });
      expect(fresh.ok).toBe(true);
      const freshData = (
        fresh as {
          ok: true;
          data: {
            source: string;
            candidates: Array<{
              name: string;
              data_flow_role: string;
              capabilities: string[];
            }>;
            potential_connections: Array<{
              from_system: string;
              to_system: string;
              data_type: string;
            }>;
          };
        }
      ).data;
      expect(freshData.source).toBe("fresh");
      expect(freshData.candidates).toHaveLength(2);
      expect(freshData.candidates[0]?.data_flow_role).toBe("source");
      expect(freshData.candidates[0]?.capabilities).toContain("read");
      expect(freshData.candidates[1]?.data_flow_role).toBe("destination");
      expect(freshData.potential_connections).toHaveLength(1);
      expect(freshData.potential_connections[0]?.from_system).toBe("Stripe");
      expect(freshData.potential_connections[0]?.to_system).toBe("HubSpot");
    } finally {
      seed.mockRestore();
    }

    const blocked = spyOn(invokeModule, "invoke").mockRejectedValue(
      new Error("must not be called"),
    );
    try {
      const cached = await discoverSystemsFromFilesTool.execute(makeCtx(), {
        knowledge_source_id: sourceId,
      });
      expect(cached.ok).toBe(true);
      const cachedData = (
        cached as {
          ok: true;
          data: {
            source: string;
            potential_connections: Array<{ from_system: string; to_system: string }>;
          };
        }
      ).data;
      expect(cachedData.source).toBe("cache");
      expect(cachedData.potential_connections).toHaveLength(1);
      expect(cachedData.potential_connections[0]?.from_system).toBe("Stripe");
    } finally {
      blocked.mockRestore();
    }
  });
});

describe("discover_systems_from_files — guards", () => {
  test("knowledge_source_id missing for tenant → knowledge_source_not_found", async () => {
    const sourceId = await seedSourceWithContent(other_tenant_id, SAMPLE_MARKDOWN);
    const spy = mockedInvokeOk();
    try {
      const r = await discoverSystemsFromFilesTool.execute(makeCtx({ tenant_id }), {
        knowledge_source_id: sourceId,
      });
      expect(r.ok).toBe(false);
      const fail = r as { ok: false; error_code?: string; next_best_actions?: string[] };
      expect(fail.error_code).toBe("knowledge_source_not_found");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("oversized content → knowledge_source_too_large", async () => {
    const huge = "x".repeat(KNOWLEDGE_SOURCE_MAX_CHARS + 1);
    const sourceId = await seedSourceWithContent(tenant_id, huge);
    const spy = mockedInvokeOk();
    try {
      const r = await discoverSystemsFromFilesTool.execute(makeCtx(), {
        knowledge_source_id: sourceId,
      });
      expect(r.ok).toBe(false);
      const fail = r as { ok: false; error_code?: string; next_best_actions?: string[] };
      expect(fail.error_code).toBe("knowledge_source_too_large");
      expect(fail.next_best_actions).toEqual(["fetch_connector_docs"]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
