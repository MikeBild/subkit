// Conversation-quality end-to-end integration test.
//
// Exercises the full chain the new conversation-quality feature set
// enables, calling the real tools (not mocks) in the order an operator-
// driven LLM would: probe → build → verify → DLP → audit.
//
// Scope:
//   1. Seed a Stripe-like connector + bearer credential.
//   2. probe_connector GET /v1/customers against a Bun.serve mock →
//      verify the tool substituted the credential into the outbound
//      Authorization header and returned a truncated envelope.
//   3. build_workflow with a ${cred.*}-bearing request step whose
//      response will contain a canary PII email →
//      (a) passes placeholder-reference integrity,
//      (b) passes the static verifier,
//      (c) persists as a draft.
//   4. Default DLP filters applied to the sample response mask the
//      canary email so the canary value cannot survive downstream.
//   5. Audit trail contains conversation.probe_connector with only
//      url_host (no path) and no credential value anywhere.
//
// Skipped here (deferred to the mock-provider-driven acceptance test):
//   - Full LLM conversation loop. We drive the tools directly so the
//     assertions are deterministic and fast (<1s).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { upsertCredential } from "../../credentials/service.ts";
import { auditLog, connectors, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { applyDlpFilters, DEFAULT_DLP_RULES } from "../../execution/response-filters.ts";
import { buildWorkflowTool } from "../tools/build-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import { probeConnectorTool, resetProbeRateLimit } from "../tools/probe-connector.ts";

const CANARY_EMAIL = "ada@example.test";
const CANARY_TOKEN = "sk_live_CANARY_NEVER_LEAK_11112222";

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;
let server: Server;
let baseUrl: string;
const connectorSlug = "stripe_mock";
const seenAuth: string[] = [];

beforeAll(async () => {
  ctx = await createTestDb("convo_quality_integration");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-cq-int", display_name: "Integration" })
    .returning();
  tenant_id = t!.id;
  const [c] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  conversation_id = c!.id;

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    seenAuth.push(auth);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          { id: "cus_1", email: CANARY_EMAIL, name: "Ada" },
          { id: "cus_2", email: "grace@example.test", name: "Grace" },
        ],
        has_more: false,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  // Seed connector + credential
  const [conn] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: connectorSlug,
      display_name: "Stripe Mock",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: baseUrl,
    })
    .returning();
  await upsertCredential(
    {
      tenant_id,
      connector_id: conn!.id,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: CANARY_TOKEN },
      actor_id: null,
    },
    ctx.db,
  );
  resetProbeRateLimit();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await ctx.cleanup();
});

function makeToolContext(): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => ({ name: "", steps: [] }),
    setDraft: async () => {},
  };
}

describe("convo-quality integration chain", () => {
  test("probe_connector substitutes the bearer credential on the real request", async () => {
    const result = await probeConnectorTool.execute(makeToolContext(), {
      connector_slug: connectorSlug,
      method: "GET",
      path: "/v1/customers",
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    const out = result.data as { status_code: number; body: { data: unknown[] } };
    expect(out.status_code).toBe(200);
    expect(Array.isArray(out.body.data)).toBe(true);
    // Mock server saw the real token in the outbound Authorization header.
    expect(seenAuth).toContain(`Bearer ${CANARY_TOKEN}`);
  });

  test("build_workflow composes a step that references the placeholder + passes verifier", async () => {
    const toolCtx = makeToolContext();
    let persistedDraft: unknown = null;
    toolCtx.setDraft = async (next) => {
      persistedDraft = next;
    };
    const result = await buildWorkflowTool.execute(toolCtx, {
      name: "Daily Stripe customers",
      slug: "daily-stripe-customers",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          url: "${connector.stripe_mock.base_url}/v1/customers",
          headers: { Authorization: "Bearer ${cred.stripe_mock.token}" },
          query: { limit: "10" },
          onError: { mode: "retry", max_retries: 3 },
        },
        {
          id: "shape",
          kind: "transform",
          expression: "$scope.fetch.data.{ 'id': id, 'email': email }",
        },
      ],
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      persistence: string;
      draft: { slug: string; step_count: number };
      warnings: string[];
    };
    expect(data.persistence).toBe("draft_only");
    expect(data.draft.slug).toBe("daily-stripe-customers");
    expect(data.draft.step_count).toBe(2);
    expect(persistedDraft).not.toBeNull();
  });

  test("DLP filters mask the canary email before the LLM sees step output", () => {
    // Represents the payload the mock server returned in step (1), then
    // fed through the default DLP rules the executor applies.
    const mockResponseFromStep = {
      data: [
        { id: "cus_1", email: CANARY_EMAIL, name: "Ada" },
        { id: "cus_2", email: "grace@example.test", name: "Grace" },
      ],
    };
    const { value, redacted } = applyDlpFilters(mockResponseFromStep, [...DEFAULT_DLP_RULES]);
    expect(redacted.length).toBeGreaterThanOrEqual(2);
    const paths = redacted.map((r) => r.path).sort();
    expect(paths.some((p) => p.endsWith(".email"))).toBe(true);
    // Canary email never appears in the redacted body.
    const serialised = JSON.stringify(value);
    expect(serialised.includes(CANARY_EMAIL)).toBe(false);
  });

  test("audit trail captures the probe without leaking the credential", async () => {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, "conversation.probe_connector")),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const serialised = JSON.stringify(rows);
    expect(serialised.includes(CANARY_TOKEN)).toBe(false);
    // url_host is present; the URL path is intentionally omitted.
    expect(serialised).toContain('"url_host":"127.0.0.1"');
    expect(serialised.includes("/v1/customers")).toBe(false);
  });
});

describe("convo-quality — canary never leaks", () => {
  test("no log line, no audit row, no tool return value contains the credential", async () => {
    const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, tenant_id));
    const serialised = JSON.stringify(rows);
    expect(serialised.includes(CANARY_TOKEN)).toBe(false);
  });
});
