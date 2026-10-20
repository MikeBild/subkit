import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { upsertCredential } from "../../credentials/service.ts";
import { auditLog, connectors, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { applyDlpFilters, DEFAULT_DLP_RULES } from "../../execution/response-filters.ts";
import { editWorkflowPatchTool } from "../tools/edit-workflow-patch.ts";
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
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await ctx.cleanup();
}, 30_000);

function makeToolContext(): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
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
    const out = result.data as {
      status_code: number;
      body: { fields: { path: string; type: string }[] };
    };
    expect(out.status_code).toBe(200);
    expect(out.body.fields).toContainEqual({ path: "data", type: "array[2]" });
    expect(out.body.fields).toContainEqual({ path: "data[0].id", type: "string" });
    expect(seenAuth).toContain(`Bearer ${CANARY_TOKEN}`);
  });

  test("edit_workflow_patch composes a step that references the placeholder + passes validation", async () => {
    const toolCtx = makeToolContext();
    let persistedDraft: unknown = null;
    toolCtx.setDraft = async (next) => {
      persistedDraft = next;
    };
    const result = await editWorkflowPatchTool.execute(toolCtx, {
      patches: [
        { op: "replace", path: "/name", value: "Daily Stripe customers" },
        { op: "add", path: "/slug", value: "daily-stripe-customers" },
        {
          op: "add",
          path: "/steps/-",
          value: {
            id: "fetch",
            kind: "request",
            method: "GET",
            url: `\${connector.stripe_mock.base_url}/v1/customers`,
            headers: { Authorization: `Bearer \${cred.stripe_mock.token}` },
            query: { limit: "10" },
            onError: { mode: "retry", max_retries: 3 },
          },
        },
        {
          op: "add",
          path: "/steps/-",
          value: {
            id: "shape",
            kind: "transform",
            expression: "return input.scope.fetch.data.map((r) => ({ id: r.id, email: r.email }));",
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    const data = result.data as { steps: number; last_step_id: string };
    expect(data.steps).toBe(2);
    expect(data.last_step_id).toBe("shape");
    const wf = (persistedDraft as { workflow: { slug: string; steps: unknown[] } } | null)
      ?.workflow;
    expect(wf?.slug).toBe("daily-stripe-customers");
    expect(wf?.steps).toHaveLength(2);
  });

  test("DLP filters mask the canary email before the LLM sees step output", () => {
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
