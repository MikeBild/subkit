// User story: As a security reviewer, I need a regression net that
// proves Tenant A's API key cannot read, write, run, or otherwise
// influence Tenant B's resources — across HTTP, MCP, and webhook
// surfaces. This pins findings #5 from the deep review (no cross-tenant
// denial integration test exists today).
//
// Acceptance criteria:
//   - AC1: HTTP — Tenant B's API key gets 404 reading/updating/deleting
//          Tenant A's workflow.
//   - AC2: HTTP — Tenant B's API key cannot run Tenant A's workflow.
//   - AC3: HTTP — Tenant B's API key gets 404 reading Tenant A's
//          connector.
//   - AC4: HTTP — Tenant B's audit query never surfaces Tenant A rows.
//   - AC5: MCP — Tenant B's MCP client does not see Tenant A's workflow
//          in `tools/list`, and a `tools/call` against Tenant A's slug
//          either returns an error or executes against Tenant B's
//          (non-existent) workflow.
//   - AC6: Webhook — when Tenant A and Tenant B both register the same
//          slug with different secrets, Tenant A's signature does not
//          unlock Tenant B's binding (and vice versa). The slug+secret
//          pair is tenant-scoped by construction.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { eq } from "drizzle-orm";
import {
  apiKeys,
  executions,
  systemAccounts,
  tenants,
  users,
  webhooksInbound,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  createDeterministicHexFactory,
  createDeterministicUuidFactory,
} from "../../test-helpers/determinism/ids.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let ctx: JourneyCtx;

// Deterministic ID factories — replace crypto.randomBytes / randomUUID
// per the determinism gate. Distinct seeds keep the produced values
// from colliding with each other across the test.
const hex = createDeterministicHexFactory(0xc1055_7e51);
const uuid = createDeterministicUuidFactory(0xc1055_7e52);

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = hex(24).slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

interface TenantBundle {
  tenantId: string;
  userId: string;
  apiKey: string;
}

/** Seed a second tenant directly through the DB so we can drive
 *  cross-tenant calls from the same engine. Mirrors the bootstrap
 *  `createJourneyCtx` does for ctx's primary tenant. */
async function seedTenant(ctx: JourneyCtx, label: string): Promise<TenantBundle> {
  const slug = `b-${label}-${hex(3)}`.slice(0, 32);
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug, display_name: `Cross-tenant ${label}` })
    .returning();
  if (!tenant) throw new Error("seed second tenant failed");
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: tenant.id,
      email: `b-${label}@test.local`,
      role: "admin",
      role_id: ctx.rbacRoleIds.admin,
    })
    .returning();
  if (!user) throw new Error("seed second tenant user failed");
  await ctx.db.insert(systemAccounts).values({
    tenant_id: tenant.id,
    name: `bot-${label}`,
    description: "cross-tenant bot",
    role_id: ctx.rbacRoleIds.admin,
  });
  const key = generateApiKey();
  await ctx.db.insert(apiKeys).values({
    tenant_id: tenant.id,
    user_id: user.id,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes: ["*"],
  });
  return { tenantId: tenant.id, userId: user.id, apiKey: key.plaintext };
}

function fetchAs(ctx: JourneyCtx, apiKey: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
}

let tenantB: TenantBundle;
let tenantAWorkflowId = "";
let tenantAWorkflowSlug = "";
let tenantAConnectorId = "";

describe("journey: cross-tenant isolation (HTTP + MCP + webhook)", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("31-cross-tenant");
    tenantB = await seedTenant(ctx, "31");

    // Tenant A: a workflow + a connector.
    tenantAWorkflowSlug = "tenant-a-only";
    const wf = await seedWorkflow(ctx, {
      slug: tenantAWorkflowSlug,
      name: "Tenant A only",
      steps: [{ id: "s1", kind: "transform", expression: '"a"' }],
    });
    tenantAWorkflowId = wf.id;

    const createConn = await journeyFetch(ctx, "/v1/connectors", {
      method: "POST",
      body: JSON.stringify({
        name: "A Connector",
        slug: "tenant-a-connector",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://api.example.com",
      }),
    });
    expect(createConn.status).toBe(201);
    tenantAConnectorId = ((await createConn.json()) as { id: string }).id;
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    if (ctx?.cleanup) await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  test("AC1: Tenant B cannot read/update/delete Tenant A's workflow over HTTP", async () => {
    const get = await fetchAs(ctx, tenantB.apiKey, `/v1/workflows/${tenantAWorkflowId}`);
    expect(get.status).toBe(404);

    // Pass schema validation first so we are sure the failure is the
    // tenant-scope check, not a syntax 400 short-circuit.
    const put = await fetchAs(ctx, tenantB.apiKey, `/v1/workflows/${tenantAWorkflowId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "stolen",
        slug: tenantAWorkflowSlug,
        steps: [{ id: "s1", kind: "transform", expression: '"stolen"' }],
      }),
    });
    expect(put.status).toBe(404);

    const del = await fetchAs(ctx, tenantB.apiKey, `/v1/workflows/${tenantAWorkflowId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(404);

    // Sanity: Tenant B's listing has zero items because they own nothing.
    const list = await fetchAs(ctx, tenantB.apiKey, "/v1/workflows");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items?: unknown[] };
    expect(body.items ?? []).toHaveLength(0);
  });

  test("AC2: Tenant B cannot run Tenant A's workflow", async () => {
    const run = await fetchAs(ctx, tenantB.apiKey, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({
        source: "saved",
        workflow_id: tenantAWorkflowId,
        input: {},
      }),
    });
    expect([403, 404]).toContain(run.status);
  });

  test("AC3: Tenant B cannot read Tenant A's connector", async () => {
    const get = await fetchAs(ctx, tenantB.apiKey, `/v1/connectors/${tenantAConnectorId}`);
    expect(get.status).toBe(404);

    const list = await fetchAs(ctx, tenantB.apiKey, "/v1/connectors");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items?: Array<{ id: string }> };
    const ids = (body.items ?? []).map((i) => i.id);
    expect(ids).not.toContain(tenantAConnectorId);
  });

  test("AC4: Tenant B's audit query does not surface Tenant A rows", async () => {
    const res = await fetchAs(ctx, tenantB.apiKey, "/v1/audit-log?limit=200");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items?: Array<{ tenant_id: string }> };
    for (const row of body.items ?? []) {
      expect(row.tenant_id).toBe(tenantB.tenantId);
    }
  });

  test("AC5: Tenant B's MCP client does not see Tenant A's workflow", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(ctx.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${tenantB.apiKey}` } },
    });
    const client = new Client({ name: "subkit-cross-tenant", version: "0.0.0" });
    try {
      await client.connect(transport as unknown as Transport);
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      // The seeded workflow lives in Tenant A; Tenant B must not see it.
      expect(names).not.toContain(`wf_${tenantAWorkflowSlug}`);

      // Calling Tenant A's tool name from Tenant B must not run Tenant
      // A's workflow. The MCP server may either reject (isError=true)
      // or treat the slug as a tenant-scoped lookup miss.
      const result = await client
        .callTool({ name: `wf_${tenantAWorkflowSlug}`, arguments: {} })
        .catch((err: unknown) => ({ isError: true, errorCause: err }));
      const isError = (result as { isError?: boolean }).isError;
      expect(isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("AC6: same slug across tenants — signatures do not cross over", async () => {
    const SHARED_SLUG = "shared-cross-tenant";
    const SECRET_A = `whsec_a_${hex(8)}`;
    const SECRET_B = `whsec_b_${hex(8)}`;

    // Tenant A: register the shared-slug binding via the public API.
    const bindA = await journeyFetch(ctx, "/v1/webhooks/inbound", {
      method: "POST",
      body: JSON.stringify({
        slug: SHARED_SLUG,
        workflow_id: tenantAWorkflowId,
        verifier: "standard",
        secret: SECRET_A,
      }),
    });
    expect(bindA.status).toBe(201);

    // Tenant B: seed a workflow + register the SAME slug with a DIFFERENT secret.
    const [b_wf] = await ctx.db
      .insert(workflows)
      .values({
        tenant_id: tenantB.tenantId,
        slug: "tenant-b-target",
        name: "Tenant B target",
        lifecycle: "active",
      })
      .returning();
    if (!b_wf) throw new Error("seed tenant B workflow failed");
    const [b_v] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenantB.tenantId,
        workflow_id: b_wf.id,
        version: 1,
        dag: {
          name: "Tenant B target",
          slug: "tenant-b-target",
          steps: [{ id: "s1", kind: "transform", expression: '"b"' }],
        },
      })
      .returning();
    if (!b_v) throw new Error("seed tenant B workflow version failed");
    await ctx.db
      .update(workflows)
      .set({ current_version_id: b_v.id })
      .where(eq(workflows.id, b_wf.id));

    const bindB = await fetchAs(ctx, tenantB.apiKey, "/v1/webhooks/inbound", {
      method: "POST",
      body: JSON.stringify({
        slug: SHARED_SLUG,
        workflow_id: b_wf.id,
        verifier: "standard",
        secret: SECRET_B,
      }),
    });
    expect(bindB.status).toBe(201);

    // Sanity: there are now two distinct rows, one per tenant, both
    // carrying the same slug. The unique constraint is `(tenant_id, slug)`.
    const countRows = await ctx.db.select().from(webhooksInbound);
    const sharedRows = countRows.filter((r) => r.slug === SHARED_SLUG);
    expect(sharedRows.length).toBeGreaterThanOrEqual(2);

    // Tenant A signs a payload with SECRET_A. The slug routes to *some*
    // binding; we verify A's signature is rejected when used against
    // any binding bound to SECRET_B by re-issuing it under both secrets.
    const body = JSON.stringify({ ts: TEST_NOW_MS });
    const webhookId = uuid();
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const ts = Math.floor(Date.now() / 1000);
    const baseStr = `${webhookId}.${ts}.${body}`;
    const sigA = `v1,${createHmac("sha256", SECRET_A).update(baseStr, "utf8").digest("base64")}`;
    const sigB = `v1,${createHmac("sha256", SECRET_B).update(baseStr, "utf8").digest("base64")}`;

    // The public endpoint resolves slug → tenant by looking at all
    // bindings; what matters is that A's secret cannot ever validate
    // against B's binding. Forge a request with sigA targeted at the
    // slug — the resolver may pick A's binding (signature ok) or B's
    // (signature rejected). To prove no cross-tenant leakage, we send
    // sigA AND verify the response is *not* a tenant B execution.
    const reqA = await fetch(`${ctx.baseUrl}/v1/hooks/${SHARED_SLUG}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": String(ts),
        "webhook-signature": sigA,
      },
      body,
    });
    // Either accepted under A's binding (200) or denied (401). Never
    // accepted into B's tenant.
    expect([200, 401, 404]).toContain(reqA.status);
    if (reqA.status === 200) {
      const env = (await reqA.json()) as { execution_id?: string };
      // If execution started, it must belong to tenant A (looked up
      // via DB to be sure — the response itself doesn't carry tenant_id).
      if (env.execution_id) {
        const exRows = await ctx.db
          .select({ tenant_id: executions.tenant_id })
          .from(executions)
          .where(eq(executions.id, env.execution_id));
        expect(exRows[0]?.tenant_id).toBe(ctx.tenantId);
      }
    }

    // Re-issue with sigB — must *not* land in tenant A.
    const webhookIdB = uuid();
    const baseStrB = `${webhookIdB}.${ts}.${body}`;
    const sigBOnly = `v1,${createHmac("sha256", SECRET_B).update(baseStrB, "utf8").digest("base64")}`;
    void sigB;
    const reqB = await fetch(`${ctx.baseUrl}/v1/hooks/${SHARED_SLUG}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookIdB,
        "webhook-timestamp": String(ts),
        "webhook-signature": sigBOnly,
      },
      body,
    });
    expect([200, 401, 404]).toContain(reqB.status);
    if (reqB.status === 200) {
      const env = (await reqB.json()) as { execution_id?: string };
      if (env.execution_id) {
        const exRows = await ctx.db
          .select({ tenant_id: executions.tenant_id })
          .from(executions)
          .where(eq(executions.id, env.execution_id));
        expect(exRows[0]?.tenant_id).toBe(tenantB.tenantId);
      }
    }
  });
});
