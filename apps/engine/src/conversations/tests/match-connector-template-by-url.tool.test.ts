import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createEmptyDraftDocument } from "../authoring-state/index.ts";
import { createConversation } from "../service.ts";
import type { ConversationTestCtx } from "../tests/setup.ts";
import { createConversationTestCtx } from "../tests/setup.ts";
import { matchConnectorTemplateByUrlTool } from "../tools/match-connector-template-by-url.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("match_template_by_url");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createToolCtx() {
  const created = await createConversation(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      title: "match-template-by-url",
    },
    ctx.testDb.db,
  );
  let draft = createEmptyDraftDocument();
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: created.conversation.id,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as never,
    getDraft: () => draft,
    setDraft: async (next: typeof draft) => {
      draft = next;
    },
  };
}

describe("matchConnectorTemplateByUrlTool", () => {
  test("tool name is match_connector_template_by_url", () => {
    expect(matchConnectorTemplateByUrlTool.name).toBe("match_connector_template_by_url");
  });

  test("Stripe URL returns matched=true and slug=stripe", async () => {
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://api.stripe.com/v1/customers",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { matched: boolean; matches: Array<{ slug: string }> };
    expect(data.matched).toBe(true);
    expect(data.matches[0]?.slug).toBe("stripe");
  });

  test("invalid URL returns matched=false", async () => {
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "not-a-url",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { matched: boolean };
    expect(data.matched).toBe(false);
  });

  test("limit is respected", async () => {
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://api.stripe.com/v1/charges",
      limit: 1,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { matches: unknown[] };
    expect(data.matches.length).toBeLessThanOrEqual(1);
  });

  test("result includes setup_instructions and credential_hints", async () => {
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://api.stripe.com/v1/charges",
      limit: 1,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      matches: Array<{ setup_instructions: string; credential_hints: unknown[] }>;
    };
    expect(data.matches[0]?.setup_instructions).toBeTruthy();
    expect(Array.isArray(data.matches[0]?.credential_hints)).toBe(true);
  });

  test("url is echoed back in the result", async () => {
    const url = "https://api.stripe.com/v1/invoices";
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, { url, limit: 3 });
    const data = result.data as { url: string };
    expect(data.url).toBe(url);
  });

  test("Atlassian tinyui URL surfaces resolved_resource with decoded page_id", async () => {
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://acme.atlassian.net/wiki/x/y4ozBQ",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      resolved_resource?: { kind: string; page_id?: number; short?: string };
    };
    expect(data.resolved_resource).toEqual({
      kind: "confluence_tinyui",
      short: "y4ozBQ",
      page_id: 87263947,
    });
  });

  test("Confluence direct-page URL resolves the numeric page_id", async () => {
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://x.atlassian.net/wiki/spaces/PROD/pages/83907824/Widget+Control",
      limit: 3,
    });
    const data = result.data as {
      resolved_resource?: { kind: string; page_id: number };
    };
    expect(data.resolved_resource).toEqual({
      kind: "confluence_page",
      page_id: 83907824,
    });
  });

  test("Non-Atlassian URLs do NOT include resolved_resource", async () => {
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://api.stripe.com/v1/charges",
      limit: 3,
    });
    const data = result.data as { resolved_resource?: unknown };
    expect(data.resolved_resource).toBeUndefined();
  });

  test("existing connector on same host surfaces as exact_match_reuse candidate", async () => {
    const toolCtx = await createToolCtx();
    await toolCtx.db.insert(connectors).values({
      tenant_id: toolCtx.tenant_id,
      slug: "existing-stripe",
      display_name: "Existing Stripe",
      driver: "http",
      auth_type: "bearer",
      base_url: "https://api.stripe.com",
    });
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://api.stripe.com/v1/charges",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      matches: Array<{
        slug: string;
        driver: string;
        auth_type: string;
        existing_connector_candidates: Array<{
          connector_slug: string;
          score: number;
          reuse_recommendation: string;
          matched_dimensions: string[];
        }>;
      }>;
    };
    const stripe = data.matches.find((m) => m.slug === "stripe");
    expect(stripe).toBeDefined();
    const candidates = stripe?.existing_connector_candidates ?? [];
    const exact = candidates.find((c) => c.connector_slug === "existing-stripe");
    expect(exact).toBeDefined();
    expect(exact?.score).toBe(3);
    expect(exact?.reuse_recommendation).toBe("exact_match_reuse");
    expect(exact?.matched_dimensions).toEqual(["driver", "base_url_host", "auth_type"]);
  });

  test("preserves the literal top-level field name 'resolved_resource' for an Atlassian URL", async () => {
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://acme.atlassian.net/wiki/x/y4ozBQ",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data)).toContain("resolved_resource");
    const resolved = data.resolved_resource as Record<string, unknown>;
    expect(resolved.kind).toBeDefined();
  });

  test("preserves the literal field name 'existing_connector_candidates' on every match", async () => {
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://api.stripe.com/v1/charges",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { matches: Array<Record<string, unknown>> };
    expect(data.matches.length).toBeGreaterThan(0);
    for (const m of data.matches) {
      expect(Object.keys(m)).toContain("existing_connector_candidates");
    }
  });

  test("reuse-recommendation enum members are literally 'exact_match_reuse' | 'reuse_with_host_override' | 'reuse_after_auth_check'", async () => {
    const toolCtx = await createToolCtx();
    await toolCtx.db.insert(connectors).values([
      {
        tenant_id: toolCtx.tenant_id,
        slug: "rec-exact",
        display_name: "rec-exact",
        driver: "http",
        auth_type: "bearer",
        base_url: "https://api.stripe.com",
      },
      {
        tenant_id: toolCtx.tenant_id,
        slug: "rec-with-host-override",
        display_name: "rec-with-host-override",
        driver: "http",
        auth_type: "bearer",
        base_url: "https://api.stripe-staging.example.com",
      },
      {
        tenant_id: toolCtx.tenant_id,
        slug: "rec-after-auth-check",
        display_name: "rec-after-auth-check",
        driver: "http",
        auth_type: "basic",
        base_url: "https://api.stripe.com",
      },
    ]);
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://api.stripe.com/v1/charges",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      matches: Array<{
        slug: string;
        existing_connector_candidates: Array<{
          connector_slug: string;
          reuse_recommendation: string;
        }>;
      }>;
    };
    const stripe = data.matches.find((m) => m.slug === "stripe");
    const candidates = stripe?.existing_connector_candidates ?? [];
    const byRec = new Map(candidates.map((c) => [c.connector_slug, c.reuse_recommendation]));
    expect(byRec.get("rec-exact")).toBe("exact_match_reuse");
    expect(byRec.get("rec-after-auth-check")).toBe("reuse_after_auth_check");
    expect(byRec.get("rec-with-host-override")).toBe("reuse_with_host_override");
  });

  test("returns the high-score match even when the tenant has > 100 connectors", async () => {
    const toolCtx = await createToolCtx();
    const filler = Array.from({ length: 120 }, (_, i) => ({
      tenant_id: toolCtx.tenant_id,
      slug: `filler-${i.toString().padStart(3, "0")}`,
      display_name: `Filler ${i}`,
      driver: "postgres",
      auth_type: "none" as const,
      base_url: `postgres://filler-${i}.local:5432/db`,
    }));
    await toolCtx.db.insert(connectors).values(filler);
    await toolCtx.db.insert(connectors).values({
      tenant_id: toolCtx.tenant_id,
      slug: "high-score-stripe",
      display_name: "High Score Stripe",
      driver: "http",
      auth_type: "bearer",
      base_url: "https://api.stripe.com",
    });
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://api.stripe.com/v1/charges",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      tenant_connectors_truncated?: boolean;
      matches: Array<{
        slug: string;
        existing_connector_candidates: Array<{ connector_slug: string; score: number }>;
      }>;
    };
    expect(data.tenant_connectors_truncated).toBeUndefined();
    const stripe = data.matches.find((m) => m.slug === "stripe");
    const candidates = stripe?.existing_connector_candidates ?? [];
    const hit = candidates.find((c) => c.connector_slug === "high-score-stripe");
    expect(hit).toBeDefined();
    expect(hit?.score).toBe(3);
  });

  test("does NOT surface connectors from another tenant on the same host", async () => {
    const toolCtx = await createToolCtx();
    const [foreignTenant] = await toolCtx.db
      .insert(tenants)
      .values({ slug: "t-foreign-stripe-w2", display_name: "Foreign Tenant" })
      .returning();
    if (!foreignTenant) throw new Error("seed foreign tenant failed");
    await toolCtx.db.insert(connectors).values({
      tenant_id: foreignTenant.id,
      slug: "foreign-stripe",
      display_name: "Foreign Stripe",
      driver: "http",
      auth_type: "bearer",
      base_url: "https://api.stripe.com",
    });
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://api.stripe.com/v1/charges",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      matches: Array<{
        slug: string;
        existing_connector_candidates: Array<{ connector_slug: string }>;
      }>;
    };
    const stripe = data.matches.find((m) => m.slug === "stripe");
    const candidates = stripe?.existing_connector_candidates ?? [];
    expect(candidates.find((c) => c.connector_slug === "foreign-stripe")).toBeUndefined();
  });
});
