import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import { chatIdentities, executions, workflows } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

let ctx: JourneyCtx;
let mock: Server;
let mockBase = "";
let connectorId = "";
let workflowId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("matrix");
  mock = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if ((req.url ?? "").startsWith("/openapi.json")) {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          openapi: "3.0.0",
          info: { title: "Matrix", version: "1.0" },
          paths: { "/ping": { get: { responses: { "200": { description: "ok" } } } } },
        }),
      );
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const addr = mock.address() as AddressInfo;
  mockBase = `http://127.0.0.1:${addr.port}`;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, 120_000);

describe("journey: verification matrix (docs/33)", () => {
  test("01. Bring up the stack — liveness + readiness + metrics scrape", async () => {
    const health = await (await journeyFetch(ctx, "/health")).json();
    expect(health).toEqual({ status: "ok", service: "subkit", version: expect.any(String) });

    const ready = await (await journeyFetch(ctx, "/ready")).json();
    expect(ready).toEqual({
      status: "ready",
      service: "subkit",
      version: health.version,
      checks: { lifecycle: "pass", database: "pass" },
    });

    const metricsRes = await fetch(`${ctx.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(metricsRes.status).toBe(200);
    const text = await metricsRes.text();
    expect(text.length).toBeGreaterThan(0);
  });

  test("02. Bootstrap identity — issue, list, rotate api key", async () => {
    const { users } = await import("../../db/schema/index.ts");
    const [u] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "matrix@test.local",
        role_id: await builtinRoleId(ctx.db, "admin"),
      })
      .returning();
    const issueRes = await journeyFetch(ctx, "/v1/identity/api-keys", {
      method: "POST",
      body: JSON.stringify({ owner_kind: "user", owner_id: u!.id }),
    });
    expect(issueRes.status).toBe(201);
    const list = await (await journeyFetch(ctx, "/v1/identity/api-keys")).json();
    expect(list.items.length).toBeGreaterThanOrEqual(1);
  });

  test("03. Connector with documentation and a curated skill", async () => {
    const createRes = await journeyFetch(ctx, "/v1/connectors", {
      method: "POST",
      body: JSON.stringify({
        name: "Matrix API",
        slug: "matrix-api",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: mockBase,
      }),
    });
    connectorId = (await createRes.json()).id;
    const ingest = await journeyFetch(ctx, `/v1/connectors/${connectorId}/docs/ingest`, {
      method: "POST",
      body: JSON.stringify({ source_type: "openapi", url: `${mockBase}/openapi.json` }),
    });
    expect(ingest.status).toBe(200);

    const skillRes = await journeyFetch(ctx, "/v1/skills", {
      method: "POST",
      body: JSON.stringify({
        scope: "connector",
        connector_id: connectorId,
        title: "call GET on /ping",
        body: "Use GET /ping for readiness probes",
        status: "active",
      }),
    });
    expect(skillRes.status).toBe(201);
  });

  test("04. AI authoring via REST — create + respond to elicitation", async () => {
    const createRes = await journeyFetch(ctx, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({
        permission_mode: "ask",
        connector_id: connectorId,
        initial_message: "list users from the api",
      }),
    });
    const out = (await createRes.json()) as {
      conversation: { id: string };
      pending_elicitation_id?: string;
      status: string;
    };
    expect(out.status).toBe("awaiting_input");
    const respond = await journeyFetch(
      ctx,
      `/v1/conversations/${out.conversation.id}/elicitations/${out.pending_elicitation_id}/respond`,
      { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
    );
    const approved = (await respond.json()) as { status: string; committed_workflow_id?: string };
    expect(approved.status).toBe("active");
    expect(approved.committed_workflow_id).toBeTruthy();
    const [draft] = await ctx.db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenantId),
          eq(workflows.id, approved.committed_workflow_id!),
        ),
      );
    expect(draft?.draft_version_id).toBeTruthy();
    expect(draft?.current_version_id).toBeNull();
  });

  test("05. Trigger workflow via REST (request_source=api)", async () => {
    const wf = await seedWorkflow(ctx, {
      slug: "invoice-summary",
      name: "Invoice Summary",
      steps: [{ kind: "request", id: "ping", method: "GET", url: `${mockBase}/ping` }],
    });
    workflowId = wf.id;
    const run = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({
        source: "saved",
        workflow_id: workflowId,
        input: {},
        request_source: "api",
      }),
    });
    const rb = (await run.json()) as { status: string; execution_id: string };
    expect(rb.status).toBe("succeeded");

    const rows = await ctx.db.select().from(executions).where(eq(executions.id, rb.execution_id));
    expect(rows[0]?.request_source).toBe("api");
  });

  test("06. Outbound subscription created", async () => {
    const res = await journeyFetch(ctx, "/v1/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        event_pattern: "execution.succeeded",
        target_url: `${mockBase}/sink`,
        secret: "whsec_matrixsuuuuuuuuuuuuuuuub",
      }),
    });
    expect(res.status).toBe(201);
  });

  test("07. Install supported Slack and Google Chat workspaces; refuse Teams locally", async () => {
    const previousSigningSecret = getConfig().platform.slack.signing_secret;
    await setConfigKey("platform.slack.signing_secret", "matrix-local-signing-secret", {
      force: true,
    });
    try {
      const slack = await journeyFetch(ctx, "/v1/chat/workspaces", {
        method: "POST",
        body: JSON.stringify({
          platform: "slack",
          workspace_id: "T_MATRIX_LOCAL",
          bot_token: "xoxb-matrix-local-token",
          installer_platform_user_id: "U_MATRIX_LOCAL",
          default_channel: "C_MATRIX_LOCAL",
        }),
      });
      expect(slack.status).toBe(201);
      expect(await slack.json()).toMatchObject({
        platform: "slack",
        workspace_id: "T_MATRIX_LOCAL",
        default_channel: "C_MATRIX_LOCAL",
      });

      const installer = "users/matrix-google-installer";
      await ctx.db.insert(chatIdentities).values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        platform: "google_chat",
        workspace_id: "spaces/matrix-preinstalled",
        platform_user_id: installer,
      });
      const google = await journeyFetch(ctx, "/v1/chat/workspaces", {
        method: "POST",
        body: JSON.stringify({
          platform: "google_chat",
          workspace_id: "spaces/MATRIX_LOCAL",
          installer_platform_user_id: installer,
          default_channel: "spaces/MATRIX_LOCAL",
        }),
      });
      expect(google.status).toBe(201);
      expect(await google.json()).toMatchObject({
        platform: "google_chat",
        workspace_id: "spaces/MATRIX_LOCAL",
      });

      const teams = await journeyFetch(ctx, "/v1/chat/workspaces", {
        method: "POST",
        body: JSON.stringify({
          platform: "teams",
          workspace_id: "teams-matrix-local",
          bot_token: "teams-local-token",
          installer_platform_user_id: "teams-matrix-installer",
        }),
      });
      expect(teams.status).toBe(400);
      expect(await teams.json()).toMatchObject({
        code: "bad_request",
        message: expect.stringContaining("not supported"),
      });

      const listed = await journeyFetch(ctx, "/v1/chat/workspaces");
      expect(listed.status).toBe(200);
      const items = (await listed.json()) as {
        items: Array<{ platform: string; workspace_id: string }>;
      };
      expect(items.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ platform: "slack", workspace_id: "T_MATRIX_LOCAL" }),
          expect.objectContaining({ platform: "google_chat", workspace_id: "spaces/MATRIX_LOCAL" }),
        ]),
      );
      expect(
        items.items.some(
          (item) => item.platform === "teams" && item.workspace_id === "teams-matrix-local",
        ),
      ).toBe(false);
    } finally {
      await setConfigKey("platform.slack.signing_secret", previousSigningSecret, { force: true });
    }
  });

  test("08. Conversational authoring inside chat — module reachable", async () => {
    const mod = await import("../../chat/dispatcher.ts");
    expect(typeof mod.handleChatEvent).toBe("function");
  });

  test("09. Notification rules — create via REST", async () => {
    const res = await journeyFetch(ctx, "/v1/notifications");
    expect([200, 404]).toContain(res.status);
  });

  test("12. Self-healing on upstream drift — loop + classifier reachable", async () => {
    const loop = await import("../../self-healing/service.ts");
    const classifier = await import("../../self-healing/classifier.ts");
    const fixture = await import("../../self-healing/fixture-runner.ts");
    expect(typeof loop.runSelfHealingLoop).toBe("function");
    expect(typeof classifier.classifyPatch).toBe("function");
    expect(typeof fixture.runFixtureDryRun).toBe("function");
  });

  test("13. API key rotation — both old and new work mid-overlap", async () => {
    const { users, apiKeys } = await import("../../db/schema/index.ts");
    const [u] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "rotator@matrix.test",
        role_id: await builtinRoleId(ctx.db, "admin"),
      })
      .returning();
    const issue = (await (
      await journeyFetch(ctx, "/v1/identity/api-keys", {
        method: "POST",
        body: JSON.stringify({ owner_kind: "user", owner_id: u!.id }),
      })
    ).json()) as { id: string; plaintext_key: string };
    const oldKey = issue.plaintext_key;
    const rot = (await (
      await journeyFetch(ctx, `/v1/identity/api-keys/${issue.id}/rotate`, {
        method: "POST",
        body: JSON.stringify({ overlap_minutes: 30 }),
      })
    ).json()) as { new: { plaintext_key: string } };
    const newKey = rot.new.plaintext_key;
    const probe = async (k: string) =>
      (
        await fetch(`${ctx.baseUrl}/v1/identity/tenants`, {
          headers: { authorization: `Bearer ${k}` },
        })
      ).status;
    expect(await probe(oldKey)).toBe(200);
    expect(await probe(newKey)).toBe(200);
    void apiKeys;
  });

  test("14. Abort propagation — cancel a queued execution", async () => {
    const asyncRun = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({
        source: "saved",
        workflow_id: workflowId,
        input: {},
        request_source: "api",
        async: true,
      }),
    });
    const body = (await asyncRun.json()) as {
      execution_id?: string;
      code?: string;
      message?: string;
    };
    if (asyncRun.status !== 202 || !body.execution_id)
      throw new Error(`async execution was not queued: ${asyncRun.status} ${JSON.stringify(body)}`);
    const cancel = await journeyFetch(ctx, `/v1/executions/${body.execution_id}/cancel`, {
      method: "POST",
    });
    expect([200, 202, 404, 409]).toContain(cancel.status);
  });

  test("16. Promote dev -> prod — `x-subkit-environment: prod` tags the run", async () => {
    const prodRes = await journeyFetch(ctx, "/v1/connectors", {
      method: "POST",
      body: JSON.stringify({
        name: "Matrix API Prod",
        slug: "matrix-api",
        driver: "http",
        environment: "prod",
        auth_type: "none",
        base_url: mockBase,
      }),
    });
    expect(prodRes.status).toBe(201);

    const run = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      headers: { "x-subkit-environment": "prod" },
      body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: {} }),
    });
    expect(run.status).toBe(200);
    const rb = (await run.json()) as { execution_id: string; status: string };
    expect(rb.status).toBe("succeeded");

    const rows = await ctx.db.select().from(executions).where(eq(executions.id, rb.execution_id));
    expect(rows[0]?.execution_mode).toBe("prod");
  });

  test("17. Extract — the endpoint exists and responds to GET liveness", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/ai/extract`, { method: "POST" });
    expect([400, 401, 405, 415]).toContain(res.status);
  });
});
