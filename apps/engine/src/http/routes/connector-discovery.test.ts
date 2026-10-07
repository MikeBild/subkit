import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as discoveryModule from "../../connectors/discovery/index.ts";
import { DiscoveryError, type DiscoveryResult } from "../../connectors/discovery/types.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { apiKeys, tenants, users } from "../../db/schema/index.ts";
import {
  knowledgeChunks,
  knowledgeSources,
  knowledgeSourceVersions,
} from "../../db/schema/knowledge_sources.ts";
import { knowledgeContentHash } from "../../knowledge/version-record.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";

const hex = createDeterministicHexFactory(0xc4112_d15c);

import { builtinRoleId, createRole } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let ctx: HttpTestServer;
let secondTenantApiKey: string;
let secondTenantId: string;
let memberApiKey: string;

const SAMPLE_RESULT: DiscoveryResult = {
  source_url: "https://api.stripe.com/openapi.json",
  fetched_at: "2026-04-26T00:00:00.000Z",
  strategy: "openapi-direct",
  spec_version: "openapi-3",
  title: "Stripe API",
  servers: ["https://api.stripe.com"],
  auth_schemes: [{ name: "bearer_auth", type: "http", scheme: "bearer" }],
  endpoints: [
    {
      method: "GET",
      path: "/v1/customers",
      summary: "List customers",
      description: null,
      operation_id: "ListCustomers",
      scopes: [],
      params: [],
      request_body_schema: null,
      request_content_type: null,
      response_schemas: { "200": { type: "object" } },
      pagination_hint: null,
      deprecated: false,
    },
  ],
  warnings: [],
};

beforeAll(async () => {
  ctx = await createHttpTestServer("conn-disc");

  const [t2] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-conn-disc-b", display_name: "Tenant B" })
    .returning();
  if (!t2) throw new Error("seed tenant B failed");
  secondTenantId = t2.id;
  const [u2] = await ctx.db
    .insert(users)
    .values({
      tenant_id: secondTenantId,
      email: "admin-conn-disc-b@test.local",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  if (!u2) throw new Error("seed user B failed");

  const rand = hex(24).slice(0, 32);
  secondTenantApiKey = `wf_live_${rand}`;
  const prefix = secondTenantApiKey.slice(0, 12);
  const hash = createHash("sha256").update(secondTenantApiKey).digest("hex");
  await ctx.db.insert(apiKeys).values({
    tenant_id: secondTenantId,
    user_id: u2.id,
    prefix,
    token_sha256: hash,
    scopes: ["*"],
  });

  const noopRole = await createRole(ctx.db, ctx.tenantId, "noop-conn-disc", "no permissions");
  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-conn-disc@test.local",
      role_id: noopRole.id,
    })
    .returning();
  if (!member) throw new Error("seed member failed");
  const memberRand = hex(24).slice(0, 32);
  memberApiKey = `wf_live_${memberRand}`;
  const memberPrefix = memberApiKey.slice(0, 12);
  const memberHash = createHash("sha256").update(memberApiKey).digest("hex");
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: member.id,
    prefix: memberPrefix,
    token_sha256: memberHash,
    scopes: ["*"],
  });
});

afterAll(async () => {
  // allow-wall-clock: real ms required to flush postgres write queue.
  await new Promise((r) => setTimeout(r, 250));
  // allow-wall-clock: wall-clock cap on cleanup to avoid Bun's 5s afterAll timeout.
  await Promise.race([ctx.cleanup(), new Promise<void>((r) => setTimeout(r, 4000))]);
}, 10_000);

describe("POST /v1/connectors/discover", () => {
  test("200 — template_id returns DiscoveryResult and persists cache row + audit", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      SAMPLE_RESULT,
    );
    try {
      const res = await fetch(`${ctx.baseUrl}/v1/connectors/discover`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ctx.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ template_id: "stripe" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        source: string;
        cache_key: string;
        result: DiscoveryResult;
      };
      expect(body.source).toBe("fresh");
      expect(body.cache_key).toBe("template:stripe");
      expect(body.result.endpoints).toHaveLength(1);
      expect(body.result.endpoints[0]?.path).toBe("/v1/customers");
      expect(spy).toHaveBeenCalledTimes(1);

      const rows = await ctx.db
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.tenant_id, ctx.tenantId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source_type).toBe("discovery_endpoint_index");
      expect(rows[0]?.slug).toBe("discovery-template-stripe");

      const audit = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenant_id, ctx.tenantId));
      const refresh = audit.find((a) => a.action === "knowledge_source.refreshed");
      expect(refresh).toBeDefined();
      expect(refresh?.reason).toBe("discovery_cache_refresh");
    } finally {
      spy.mockRestore();
    }
  });

  test("400 — empty body fails Zod refinement", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/connectors/discover`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("403 — non-admin member without connector:read grant is rejected", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      SAMPLE_RESULT,
    );
    try {
      const res = await fetch(`${ctx.baseUrl}/v1/connectors/discover`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${memberApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ template_id: "stripe" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("forbidden");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("401 — missing bearer is rejected by auth", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/connectors/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template_id: "stripe" }),
    });
    expect(res.status).toBe(401);
  });

  test("503 — every strategy bailing surfaces as discovery_unavailable", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockRejectedValue(
      new DiscoveryError("all_strategies_failed", "every strategy bailed"),
    );
    try {
      const res = await fetch(`${ctx.baseUrl}/v1/connectors/discover`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ctx.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ template_id: "no-such-template" }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("discovery_unavailable");
      expect(body.message).toContain("every strategy bailed");
    } finally {
      spy.mockRestore();
    }
  });

  test("tenant isolation — tenant A's cached discovery is not returned for tenant B", async () => {
    const seed = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      SAMPLE_RESULT,
    );
    const aRes = await fetch(`${ctx.baseUrl}/v1/connectors/discover`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ template_id: "stripe" }),
    });
    expect(aRes.status).toBe(200);
    seed.mockRestore();

    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue({
      ...SAMPLE_RESULT,
      title: "Tenant B view",
    });
    try {
      const bRes = await fetch(`${ctx.baseUrl}/v1/connectors/discover`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secondTenantApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ template_id: "stripe" }),
      });
      expect(bRes.status).toBe(200);
      const body = (await bRes.json()) as {
        source: string;
        result: DiscoveryResult;
      };
      expect(body.source).toBe("fresh");
      expect(body.result.title).toBe("Tenant B view");
      expect(spy).toHaveBeenCalledTimes(1);

      const aRows = await ctx.db
        .select()
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.tenant_id, ctx.tenantId),
            eq(knowledgeSources.slug, "discovery-template-stripe"),
          ),
        );
      expect(aRows).toHaveLength(1);
      const bRows = await ctx.db
        .select()
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.tenant_id, secondTenantId),
            eq(knowledgeSources.slug, "discovery-template-stripe"),
          ),
        );
      expect(bRows).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST /v1/connectors/discover — the cache keeps a true history", () => {
  test("each changed refresh is a version of exactly the stored index; an unchanged one is not", async () => {
    const discover = (result: DiscoveryResult) => {
      const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(result);
      return fetch(`${ctx.baseUrl}/v1/connectors/discover`, {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ template_id: "history-probe", force_refresh: true }),
      }).finally(() => spy.mockRestore());
    };
    const changed = { ...SAMPLE_RESULT, title: "Stripe API v2" };
    expect((await discover(SAMPLE_RESULT)).status).toBe(200);
    expect((await discover(SAMPLE_RESULT)).status).toBe(200);
    expect((await discover(changed)).status).toBe(200);

    const [source] = await ctx.db
      .select()
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.tenant_id, ctx.tenantId),
          eq(knowledgeSources.slug, "discovery-template-history-probe"),
        ),
      );
    if (!source) throw new Error("discovery cache row missing");
    const versions = await ctx.db
      .select()
      .from(knowledgeSourceVersions)
      .where(
        and(
          eq(knowledgeSourceVersions.tenant_id, ctx.tenantId),
          eq(knowledgeSourceVersions.knowledge_source_id, source.id),
        ),
      );
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    const [chunk] = await ctx.db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.knowledge_source_id, source.id));
    const latest = versions.find((v) => v.version === 2);
    expect(latest?.content).toMatchObject({ kind: "document", text: chunk?.content });
    expect(latest?.content_hash).toBe(knowledgeContentHash(chunk?.content ?? ""));
    expect(latest?.content_hash).toBe(source.version);
  });
});
