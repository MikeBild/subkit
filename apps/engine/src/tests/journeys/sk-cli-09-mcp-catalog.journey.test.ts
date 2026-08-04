// User story: As a client integration, I need the REST MCP catalog
// endpoints (`/v1/mcp/prompts`, `/v1/mcp/resources`, `/v1/mcp/tools`)
// to honor the `mcp:read` permission — admins and members get
// them, endusers and portal-token principals are denied — and to
// return shape-stable JSON envelopes that the `sk` CLI slash
// picker consumes verbatim.
//
// Acceptance criteria:
//
//   AC1. Admin can GET all three endpoints and receive 200 +
//        `items: []` (empty on a fresh tenant).
//   AC2. Seeding a skill + connector causes /v1/mcp/prompts and
//        /v1/mcp/resources to surface them, in catalog shape.
//   AC3. /v1/mcp/tools returns the same MCP tool catalog `tools/list`
//        serves — not the conversation loop's draft-only palette.
//   AC4. A member user is allowed (has `mcp:read` via the built-in
//        role), returns 200.
//   AC5. An enduser user is denied (403) — endusers cannot
//        introspect MCP in v1 of the sk rollout.
//   AC6. A portal-token principal is also denied (403) — the
//        evaluator's allowlist branch does not grant `mcp:read`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, connectors, portalTokens, skills, users } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let ctx: JourneyCtx;
let memberApiKey = "";
let enduserApiKey = "";
let portalToken = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

async function fetchAs(apiKey: string, path: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
}

describe("journey: sk-cli MCP catalog endpoints", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-09-mcp-catalog");

    // Seed a member user with their own API key.
    const [member] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "member@sk-cli-09.test",
        role: "member",
        role_id: ctx.rbacRoleIds.member,
      })
      .returning();
    if (!member) throw new Error("failed to seed member");
    const memberRand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
    memberApiKey = `wf_live_${memberRand}`;
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: member.id,
      prefix: memberApiKey.slice(0, 12),
      token_sha256: sha256Hex(memberApiKey),
      scopes: ["*"],
    });

    // Seed an enduser user + API key.
    const [enduser] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "enduser@sk-cli-09.test",
        role: "enduser",
        role_id: ctx.rbacRoleIds.enduser,
      })
      .returning();
    if (!enduser) throw new Error("failed to seed enduser");
    const enduserRand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
    enduserApiKey = `wf_live_${enduserRand}`;
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: enduser.id,
      prefix: enduserApiKey.slice(0, 12),
      token_sha256: sha256Hex(enduserApiKey),
      scopes: ["*"],
    });

    // Seed a portal-token principal.
    const portalRand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
    portalToken = `wf_portal_${portalRand}`;
    await ctx.db.insert(portalTokens).values({
      tenant_id: ctx.tenantId,
      enduser_ref: enduser.id,
      prefix: portalToken.slice(0, 14),
      token_sha256: sha256Hex(portalToken),
      allowed_workflows: ["*"],
      expires_at: new Date(TEST_NOW_MS + 3600_000),
    });
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  test("AC1: admin GET /v1/mcp/{prompts,resources,tools} returns 200", async () => {
    for (const path of ["/v1/mcp/prompts", "/v1/mcp/resources", "/v1/mcp/tools"]) {
      const res = await journeyFetch(ctx, path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(Array.isArray(body.items)).toBe(true);
    }
  });

  test("AC2: seeded skill + connector surface in prompts and resources", async () => {
    const [skill] = await ctx.db
      .insert(skills)
      .values({
        tenant_id: ctx.tenantId,
        scope: "global",
        title: "Use JSON-first APIs",
        body: "Prefer application/json over text/xml when both are available.",
        lifecycle: "active",
        version: 1,
      })
      .returning();
    expect(skill).toBeDefined();

    const [conn] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id: ctx.tenantId,
        slug: "jsonplaceholder",
        display_name: "JSONPlaceholder",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://jsonplaceholder.typicode.com",
      })
      .returning();
    expect(conn).toBeDefined();

    const promptsRes = await journeyFetch(ctx, "/v1/mcp/prompts");
    const prompts = (await promptsRes.json()) as {
      items: Array<{ name: string; scope: string; skill_id: string }>;
    };
    const matching = prompts.items.find((p) => p.skill_id === skill?.id);
    expect(matching?.scope).toBe("global");

    const resourcesRes = await journeyFetch(ctx, "/v1/mcp/resources");
    const resources = (await resourcesRes.json()) as {
      items: Array<{ uri: string; name: string }>;
    };
    const connUri = `connector://${conn?.id ?? ""}`;
    const matchingConn = resources.items.find((r) => r.uri === connUri);
    expect(matchingConn?.name).toBe("jsonplaceholder");
  });

  test("AC3: /v1/mcp/tools returns the MCP tool catalog, not the authoring palette", async () => {
    // This assertion was inverted: it required `author_workflow`,
    // `save_workflow_draft` and `request_human_approval` — the authoring loop's
    // draft-only intents, which the MCP surface omits on purpose. The route
    // served them from a constant, so against production it and `tools/list`
    // for the same principal shared not one name, 7 against 107.
    const res = await journeyFetch(ctx, "/v1/mcp/tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ name: string; input_shape: unknown }> };
    const names = new Set(body.items.map((i) => i.name));

    // The retired constant must not come back.
    for (const retired of ["author_workflow", "save_workflow_draft", "request_human_approval"]) {
      expect(names.has(retired)).toBe(false);
    }
    // And the catalog is really there: a tool every mode publishes, plus a
    // populated `input_shape` — the field that was `null` on every entry.
    expect(names.has("list_recipes")).toBe(true);
    expect(body.items.some((i) => i.input_shape !== null)).toBe(true);
  });

  test("AC4: member is allowed (mcp:read granted via built-in role)", async () => {
    const res = await fetchAs(memberApiKey, "/v1/mcp/prompts");
    expect(res.status).toBe(200);
  });

  test("AC5: enduser is denied mcp:read", async () => {
    const res = await fetchAs(enduserApiKey, "/v1/mcp/prompts");
    expect(res.status).toBe(403);
  });

  test("AC6: portal-token principal is denied mcp:read", async () => {
    const res = await fetchAs(portalToken, "/v1/mcp/prompts");
    expect(res.status).toBe(403);
  });
});
