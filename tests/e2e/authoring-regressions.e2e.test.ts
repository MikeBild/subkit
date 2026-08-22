import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server as HttpServer } from "node:http";
import { conversations, tenants } from "../../apps/engine/src/db/schema/index.ts";
import type { ConverseMockStep } from "../../apps/engine/src/llm/mock-provider.ts";
import { getMockProvider } from "../../apps/engine/src/llm/mock-provider.ts";
import { getTestNow } from "../../apps/engine/src/test-helpers/determinism/clock.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let env: E2EEnv;
let httpServer: ReturnType<typeof Bun.serve>;
let graphqlServer: ReturnType<typeof Bun.serve>;
let s3Server: HttpServer;
let httpBaseUrl = "";
let graphqlBaseUrl = "";
let s3BaseUrl = "";

beforeAll(async () => {
  env = await boot("authoring-regressions", { llm: "mock" });
  httpServer = Bun.serve({
    port: 0,
    // Pinned: the suite dials 127.0.0.1, so the server must bind it too.
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      // Suffix matching: each connector-creating test uses a DISTINCT
      // base_url prefix (e.g. /papi, /zxqp) on this one server, because a
      // green probe AUTO-PERSISTS its connector and
      // start_connector_from_description dedupes by base_url — two tests
      // sharing the exact base_url would short-circuit into the reuse
      // envelope instead of exercising a fresh draft.
      if (url.pathname.endsWith("/health"))
        return Response.json({ ok: true, source: "authoring-e2e" });
      if (url.pathname.endsWith("/protected")) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (url.pathname.endsWith("/slow")) {
        // Simulates a 250ms upstream RTT — must exceed the 100ms probe
        // timeout used by the probe-timeout test below, and long enough
        // to let the cancel-race test (line ~470) preempt the request.
        await new Promise((resolve) => setTimeout(resolve, 250)); // allow-wall-clock: simulates slow upstream for probe-timeout + cancel-race tests
        return Response.json({ ok: true, delayed: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  graphqlServer = Bun.serve({
    port: 0,
    // Pinned: the suite dials 127.0.0.1, so the server must bind it too.
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return Response.json({ data: { __typename: "Query" } });
    },
  });
  s3Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          "<ListBucketResult>",
          "<Name>demo</Name>",
          "<Prefix></Prefix>",
          "<KeyCount>0</KeyCount>",
          "<MaxKeys>1000</MaxKeys>",
          "<IsTruncated>false</IsTruncated>",
          "</ListBucketResult>",
        ].join(""),
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    s3Server.once("error", reject);
    s3Server.listen(0, "127.0.0.1", () => resolve());
  });
  httpBaseUrl = `http://127.0.0.1:${httpServer.port}`;
  graphqlBaseUrl = `http://127.0.0.1:${graphqlServer.port}`;
  const s3Address = s3Server.address();
  if (!s3Address || typeof s3Address === "string") {
    throw new Error("failed to resolve s3 stub port");
  }
  s3BaseUrl = `http://127.0.0.1:${s3Address.port}`;
}, 90_000);

afterAll(async () => {
  httpServer.stop(true);
  graphqlServer.stop(true);
  await new Promise<void>((resolve, reject) => {
    s3Server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await shutdown(env);
}, 30_000);

function adminHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${env.personas.admin.apiKey}`,
    "Content-Type": "application/json",
  };
}

async function createConversation(body: Record<string, unknown> = {}): Promise<{
  conversation: { id: string; status: string };
  status: string;
}> {
  const response = await fetch(`${env.baseUrl}/v1/conversations`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    conversation: { id: string; status: string };
    status: string;
  };
}

async function appendMessage(
  conversationId: string,
  message: string,
): Promise<{
  status: string;
  pending_elicitation_id?: string;
}> {
  const response = await fetch(`${env.baseUrl}/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ message }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { status: string; pending_elicitation_id?: string };
}

async function getConversation(conversationId: string): Promise<{
  conversation: { id: string; status: string };
  draft: {
    mode?: string;
    summary?: { next_action?: string | null; missing_fields?: string[] };
    connector?: {
      template_slug?: string | null;
      template_name?: string | null;
      validation?: { missing_fields?: string[] };
      latest_probe?: { ok: boolean; summary: string; status_code?: number; failure_code?: string };
    };
    latest_preview?: { ok: boolean; summary: string };
  } | null;
  resume_summary?: {
    pending_approval: { id: string; tool_name: string; summary: string } | null;
    next_action: string;
  } | null;
}> {
  const response = await fetch(`${env.baseUrl}/v1/conversations/${conversationId}`, {
    headers: adminHeaders(),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    conversation: { id: string; status: string };
    draft: {
      connector?: {
        latest_probe?: {
          ok: boolean;
          summary: string;
          status_code?: number;
          failure_code?: string;
        };
      };
      latest_preview?: { ok: boolean; summary: string };
    } | null;
    resume_summary?: {
      pending_approval: { id: string; tool_name: string; summary: string } | null;
      next_action: string;
    } | null;
  };
}

async function runPlan(
  plan: ConverseMockStep[],
  message = "continue",
): Promise<{
  conversationId: string;
  outcome: { status: string; pending_elicitation_id?: string };
  detail: Awaited<ReturnType<typeof getConversation>>;
}> {
  const created = await createConversation({ title: "authoring-regression" });
  const conversationId = created.conversation.id;
  getMockProvider().setConversePlan(conversationId, plan);
  const outcome = await appendMessage(conversationId, message);
  const detail = await getConversation(conversationId);
  return { conversationId, outcome, detail };
}

describe("authoring regressions", () => {
  test("onboarding without a saved endpoint still asks for the missing connector details", async () => {
    const { detail } = await runPlan([
      {
        tool: "start_connector_from_description",
        args: {
          name: "Quokka Ledger",
          description: "Private ledger sync endpoint for backoffice use",
          driver: "http",
          environment: "dev",
          auth_type: "none",
        },
      },
    ]);
    expect(["onboarding", "connector_authoring"]).toContain(detail.draft?.mode ?? "onboarding");
    expect(
      (detail.draft?.summary?.missing_fields ?? []).some((field) => field.startsWith("base_url")),
    ).toBe(true);
    expect((detail.draft?.summary?.next_action ?? "").length).toBeGreaterThan(0);
  });

  test("onboarding with a template preserves template metadata and unresolved fields", async () => {
    const { detail } = await runPlan([
      {
        tool: "start_connector_from_template",
        args: {
          template_slug: "shopify",
          environment: "dev",
        },
      },
    ]);
    expect(detail.draft?.connector?.template_slug).toBe("shopify");
    expect(detail.draft?.connector?.validation?.missing_fields ?? []).toContain("base_url.shop");
    expect(detail.draft?.summary?.missing_fields ?? []).toContain("base_url.shop");
  });

  test("resume summary surfaces pending approval after connector save pause", async () => {
    const { outcome, detail } = await runPlan([
      {
        tool: "start_connector_from_description",
        args: {
          name: "Pending Approval API",
          driver: "http",
          environment: "dev",
          base_url: `${httpBaseUrl}/papi`,
          auth_type: "none",
        },
      },
      { tool: "validate_connector_draft", args: {} },
      { tool: "probe_connector_draft", args: { method: "GET", path: "/health" } },
      { tool: "save_connector_draft", args: {} },
    ]);
    expect(outcome.status).toBe("awaiting_input");
    expect(outcome.pending_elicitation_id).toBeTruthy();
    expect(detail.conversation.status).toBe("awaiting_input");
    expect(detail.resume_summary?.pending_approval?.tool_name).toBe("ask_user_confirm");
    expect(detail.resume_summary?.next_action).toContain("approve");
  });

  test("workflow history restore promotes an old version back to current", async () => {
    const slug = `restore-e2e-${TEST_NOW_MS}`;
    const created = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        name: "restore-e2e",
        slug,
        steps: [{ id: "fetch", kind: "request", method: "GET", url: "https://example.com/v1" }],
      }),
    });
    expect(created.status).toBe(201);
    const workflow = (await created.json()) as {
      id: string;
      current_version: number;
      steps: Array<{ url?: string }>;
    };

    const updated = await fetch(`${env.baseUrl}/v1/workflows/${workflow.id}`, {
      method: "PUT",
      headers: adminHeaders(),
      body: JSON.stringify({
        name: "restore-e2e",
        slug,
        steps: [{ id: "fetch", kind: "request", method: "GET", url: "https://example.com/v2" }],
      }),
    });
    expect(updated.status).toBe(200);

    const history = await fetch(`${env.baseUrl}/v1/workflows/${workflow.id}/history`, {
      headers: adminHeaders(),
    });
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as {
      items: Array<{ version: number }>;
    };
    expect(historyBody.items.map((item) => item.version)).toEqual(expect.arrayContaining([1, 2]));

    const restored = await fetch(`${env.baseUrl}/v1/workflows/${workflow.id}/restore/1`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(restored.status).toBe(200);
    const restoredBody = (await restored.json()) as {
      current_version: number;
      steps: Array<{ url?: string }>;
    };
    expect(restoredBody.current_version).toBe(3);
    expect(restoredBody.steps[0]?.url).toBe("https://example.com/v1");

    const current = await fetch(`${env.baseUrl}/v1/workflows/${workflow.id}`, {
      headers: adminHeaders(),
    });
    expect(current.status).toBe(200);
    const currentBody = (await current.json()) as {
      current_version: number;
      steps: Array<{ url?: string }>;
    };
    expect(currentBody.current_version).toBe(3);
    expect(currentBody.steps[0]?.url).toBe("https://example.com/v1");
  });

  test("HTTP draft probes surface 401 and timeout distinctly", async () => {
    const unauthorized = await runPlan([
      {
        tool: "start_connector_from_description",
        args: {
          name: "zxqprotected",
          driver: "http",
          environment: "dev",
          base_url: `${httpBaseUrl}/zxqp`,
          auth_type: "none",
        },
      },
      { tool: "validate_connector_draft", args: {} },
      { tool: "probe_connector_draft", args: { method: "GET", path: "/protected" } },
    ]);
    expect(unauthorized.detail.draft?.connector?.latest_probe?.ok).toBe(false);
    expect(unauthorized.detail.draft?.connector?.latest_probe?.status_code).toBe(401);
    expect(unauthorized.detail.draft?.connector?.latest_probe?.summary).toContain("HTTP 401");

    const timeout = await runPlan([
      {
        tool: "start_connector_from_description",
        args: {
          name: "zxqslow",
          driver: "http",
          environment: "dev",
          base_url: `${httpBaseUrl}/zxqs`,
          auth_type: "none",
        },
      },
      { tool: "validate_connector_draft", args: {} },
      { tool: "probe_connector_draft", args: { method: "GET", path: "/slow", timeout_ms: 100 } },
    ]);
    expect(timeout.detail.draft?.connector?.latest_probe?.ok).toBe(false);
    expect(timeout.detail.draft?.connector?.latest_probe?.failure_code).toBe("probe_timeout");
    expect(timeout.detail.draft?.connector?.latest_probe?.summary).toContain("timed out");
  });

  test("driver-specific draft probes work for GraphQL, Postgres, and S3", async () => {
    const graphql = await runPlan([
      {
        tool: "start_connector_from_description",
        args: {
          name: "zxqgraph",
          driver: "graphql",
          environment: "dev",
          base_url: graphqlBaseUrl,
          auth_type: "none",
        },
      },
      { tool: "validate_connector_draft", args: {} },
      { tool: "probe_connector_draft", args: { path: "/" } },
    ]);
    expect(graphql.detail.draft?.connector?.latest_probe?.ok).toBe(true);
    expect(graphql.detail.draft?.connector?.latest_probe?.summary).toContain("GraphQL");

    const postgres = await runPlan([
      {
        tool: "start_connector_from_description",
        args: {
          name: "zxqpostgres",
          driver: "postgres",
          environment: "dev",
          dsn: env.testDb.url,
          auth_type: "none",
        },
      },
      { tool: "validate_connector_draft", args: {} },
      { tool: "probe_connector_draft", args: {} },
    ]);
    expect(postgres.detail.draft?.connector?.latest_probe?.ok).toBe(true);
    expect(postgres.detail.draft?.connector?.latest_probe?.summary).toContain("postgres");

    const s3 = await runPlan([
      {
        tool: "start_connector_from_description",
        args: {
          name: "zxqs3",
          driver: "s3",
          environment: "dev",
          base_url: s3BaseUrl,
          auth_type: "none",
        },
      },
      {
        tool: "update_connector_draft",
        args: {
          config: {
            bucket: "demo",
            region: "us-east-1",
            endpoint: s3BaseUrl,
            force_path_style: true,
          },
        },
      },
      { tool: "validate_connector_draft", args: {} },
      { tool: "probe_connector_draft", args: {} },
    ]);
    expect(s3.detail.draft?.connector?.latest_probe?.ok).toBe(true);
    expect(s3.detail.draft?.connector?.latest_probe?.summary).toContain("s3");
  });

  test("preview failures stay in latest_preview instead of 500ing the turn", async () => {
    const { outcome, detail } = await runPlan([
      {
        tool: "build_workflow",
        args: {
          name: "preview-failure",
          slug: "preview-failure",
          steps: [
            {
              id: "explode",
              kind: "transform",
              expression: "$nonexistent_fn(input)",
            },
          ],
        },
      },
      { tool: "dry_run_step", args: { step_id: "explode", input: { ok: true } } },
    ]);
    expect(outcome.status).toBe("active");
    expect(detail.draft?.latest_preview?.ok).toBe(false);
    expect(detail.draft?.latest_preview?.summary.length).toBeGreaterThan(0);
  });

  // SYNC-REGISTER CONTRACT (cancel-race e2e cover).
  //
  // The unit-level contract for the abort registry lives at
  // `apps/engine/src/conversations/abort.test.ts` ("SSE
  // ownership-transfer", "cross-tenant displacement"). Those cases
  // are the authoritative regression guard against the cancel race.
  // This e2e is the *integration cover* — it pins that the full
  // HTTP → cancel registry → loop abort path keeps the contract
  // end-to-end on a real engine.
  //
  // The test deliberately fires POST /messages and POST /cancel
  // back-to-back without an intervening sleep: the post-A4
  // sync-register guarantees the cancel always finds a controller
  // because registration happens on the synchronous frame of
  // request-accept. If a future refactor regresses register back
  // inside an async hop, the e2e will fail intermittently (cancel
  // arrives after the regressed register on a fast loopback) — but
  // the unit test in `abort.test.ts` will fail cleanly, so don't
  // chase intermittent e2e failures here without checking the unit
  // suite first.
  test("sync-register contract — cancelling a slow preview abandons the turn without surfacing a 500", async () => {
    const created = await createConversation({ title: "preview-cancel" });
    const conversationId = created.conversation.id;
    getMockProvider().setConversePlan(conversationId, [
      {
        tool: "build_workflow",
        args: {
          name: "preview-cancel",
          slug: `preview-cancel-${TEST_NOW_MS}`,
          steps: [
            {
              id: "fetch",
              kind: "request",
              method: "GET",
              url: `${httpBaseUrl}/slow`,
            },
          ],
        },
      },
      { tool: "dry_run_step", args: { step_id: "fetch", budget_ms: 10_000 } },
    ]);

    const turnPromise = fetch(`${env.baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ message: "preview the slow request now" }),
    });
    const cancel = await fetch(`${env.baseUrl}/v1/conversations/${conversationId}/cancel`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(cancel.status).toBe(200);

    const turn = await turnPromise;
    expect(turn.status).toBe(200);
    const outcome = (await turn.json()) as { status: string };
    expect(outcome.status).toBe("abandoned");

    const detail = await getConversation(conversationId);
    expect(detail.conversation.status).toBe("abandoned");
  });

  test("tenant isolation blocks reading a foreign conversation id", async () => {
    const [foreignTenant] = await env.db
      .insert(tenants)
      .values({ slug: `foreign-${TEST_NOW_MS}`, display_name: "Foreign tenant" })
      .returning();
    expect(foreignTenant).toBeDefined();
    const [foreignConversation] = await env.db
      .insert(conversations)
      .values({
        tenant_id: foreignTenant!.id,
        status: "active",
        title: "foreign conversation",
      })
      .returning();
    expect(foreignConversation).toBeDefined();

    const response = await fetch(`${env.baseUrl}/v1/conversations/${foreignConversation!.id}`, {
      headers: adminHeaders(),
    });
    expect(response.status).toBe(404);
  });
});
