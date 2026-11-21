import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import { executions, sessions, workflows } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const SLUG = "chat-drafted-notice";

let ctx: JourneyCtx;
let echo: Server;
let echoBase = "";
const received: Array<{ method: string; url: string; body: string }> = [];
let connectorId = "";
let conversationId = "";
let workflowId = "";
let draftVersionId = "";
let authorityId = "";
let executionId = "";
let browser: Record<string, string> = {};

interface Preview {
  digest: string;
  execution_shape: unknown;
  suggested_bounds: { valid_from: string; valid_until: string; max_runs: number };
}

async function workflowRow() {
  const [row] = await ctx.db
    .select({
      lifecycle: workflows.lifecycle,
      draft: workflows.draft_version_id,
      current: workflows.current_version_id,
    })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.slug, SLUG)));
  return row;
}

async function runCount(): Promise<number> {
  const rows = await ctx.db
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflowId)));
  return rows.length;
}

function run(key: string) {
  return journeyFetch(ctx, "/v1/executions", {
    method: "POST",
    body: JSON.stringify({
      source: "saved",
      workflow_id: workflowId,
      execution_authority_id: authorityId,
      idempotency_key: key,
      input: {},
    }),
  });
}

beforeAll(async () => {
  ctx = await createJourneyCtx("chat-draft-approve-run", {
    envOverrides: { MASTER_KEY: "cd".repeat(32) },
  });
  echo = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ delivered: true, id: `notice-${received.length}` }));
    });
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
  echoBase = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;

  const connector = await journeyFetch(ctx, "/v1/connectors", {
    method: "POST",
    body: JSON.stringify({
      name: "Notices",
      slug: "notices",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: echoBase,
    }),
  });
  expect(connector.status).toBe(201);
  connectorId = ((await connector.json()) as { id: string }).id;

  const now = await databaseNow(ctx.db);
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      expires_at: new Date(now.getTime() + 3_600_000),
      absolute_expires_at: new Date(now.getTime() + 3_600_000),
    })
    .returning();
  if (!session) throw new Error("missing browser session fixture");
  const payload = { tenant_id: ctx.tenantId, user_id: ctx.userId, session_id: session.id };
  browser = {
    cookie: browserSessionCookie(await signBrowserSession(payload)),
    "x-subkit-csrf": await signBrowserCsrf(payload),
    "content-type": "application/json",
  };
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (echo) await new Promise<void>((resolve) => echo.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("a chat-drafted workflow is reviewed, approved within limits, run and audited", () => {
  test("the chat drafts the workflow and saves it as an inert draft", async () => {
    const created = await journeyFetch(ctx, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    conversationId = ((await created.json()) as { conversation: { id: string } }).conversation.id;
    getMockProvider().setConversePlan(conversationId, [
      {
        tool: "edit_workflow_patch",
        args: {
          patches: [
            { op: "replace", path: "/name", value: SLUG },
            { op: "add", path: "/slug", value: SLUG },
            { op: "add", path: "/description", value: "Sends the daily notice." },
            {
              op: "add",
              path: "/steps/-",
              value: {
                id: "send",
                kind: "request",
                method: "POST",
                connector_id: connectorId,
                path: "/notices",
                body: { text: "Daily notice" },
              },
            },
          ],
        },
      },
      { tool: "inspect_workflow_draft", args: {} },
      { tool: "validate_draft", args: {} },
      { tool: "dry_run_workflow", args: { input: {} } },
      { tool: "save_workflow_draft", args: {} },
      { text: "Der Entwurf ist gespeichert." },
    ]);
    const turn = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: "Erstelle einen Workflow, der die Tagesnotiz sendet" }),
    });
    expect([200, 202]).toContain(turn.status);
    const outcome = (await turn.json()) as { status: string; pending_elicitation_id?: string };
    if (outcome.status === "awaiting_input" && outcome.pending_elicitation_id) {
      const answered = await journeyFetch(
        ctx,
        `/v1/conversations/${conversationId}/elicitations/${outcome.pending_elicitation_id}/respond`,
        { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
      );
      expect([200, 202]).toContain(answered.status);
    }

    const row = await workflowRow();
    expect(row?.lifecycle).toBe("draft");
    expect(row?.draft).toBeTruthy();
    expect(row?.current).toBeNull();
    draftVersionId = row?.draft ?? "";
    const [wf] = await ctx.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.slug, SLUG)));
    workflowId = wf?.id ?? "";
    expect(await runCount()).toBe(0);
    expect(received).toEqual([]);
  });

  test("the review names the target and a machine key cannot approve it", async () => {
    const preview = await journeyFetch(
      ctx,
      `/v1/workflows/${workflowId}/versions/${draftVersionId}/authority-preview?environment=dev`,
    );
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as Preview;
    expect(JSON.stringify(body.execution_shape)).toContain("Daily notice");
    expect(body.suggested_bounds.max_runs).toBeGreaterThanOrEqual(1);

    const grant = {
      workflow_version_id: draftVersionId,
      execution_environment: "dev",
      expected_manifest_digest: body.digest,
      valid_from: body.suggested_bounds.valid_from,
      valid_until: body.suggested_bounds.valid_until,
      max_runs: 1,
      activation: { expected_current_version_id: null },
      conversation_id: conversationId,
    };
    const machine = await journeyFetch(ctx, `/v1/workflows/${workflowId}/execution-authorities`, {
      method: "POST",
      body: JSON.stringify(grant),
    });
    expect(machine.status).toBe(403);
    expect(await workflowRow()).toMatchObject({ current: null });

    const approved = await fetch(
      `${ctx.baseUrl}/v1/workflows/${workflowId}/execution-authorities`,
      {
        method: "POST",
        headers: browser,
        body: JSON.stringify(grant),
      },
    );
    expect(approved.status).toBe(201);
    authorityId = ((await approved.json()) as { id: string }).id;

    const read = await fetch(
      `${ctx.baseUrl}/v1/workflows/${workflowId}/execution-authorities/${authorityId}`,
      { headers: browser },
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      state: "approved",
      execution_environment: "dev",
      remaining_runs: 1,
    });
    expect(await workflowRow()).toMatchObject({ current: draftVersionId });
  });

  test("the approved run delivers once and the run page shows its result", async () => {
    const started = await run("chat-draft-first");
    expect(started.status).toBe(200);
    const result = (await started.json()) as { execution_id: string; status: string };
    expect(result.status).toBe("succeeded");
    executionId = result.execution_id;
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "POST", url: "/notices" });
    expect(JSON.parse(received[0]?.body ?? "{}")).toEqual({ text: "Daily notice" });

    const page = await journeyFetch(ctx, `/v1/executions/${executionId}`);
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      id: executionId,
      workflow_id: workflowId,
      status: "succeeded",
      execution_authority_id: authorityId,
    });
    const steps = await journeyFetch(ctx, `/v1/executions/${executionId}/steps`);
    expect(steps.status).toBe(200);
    expect(JSON.stringify(await steps.json())).toContain("notice-1");
  });

  test("a second run after the limit is used up is refused with its reason", async () => {
    const refused = await run("chat-draft-second");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "execution_authority_unavailable" });
    expect(received).toHaveLength(1);
    expect(await runCount()).toBe(1);
  });

  test("the audit names the person for the draft, the approval and the run", async () => {
    const res = await journeyFetch(ctx, `/v1/audit-log?actor_id=${ctx.userId}&limit=500`);
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { items: Array<{ action: string; resource_id?: string }> })
      .items;
    const trail = rows.map((row) => `${row.action}:${row.resource_id}`);
    expect(trail).toContain(`workflow.created:${workflowId}`);
    expect(trail).toContain(`workflow.authority_granted:${authorityId}`);
    expect(trail).toContain(`execution.completed:${executionId}`);
    expect(trail).toContain(`execution.boundary_refused:${workflowId}`);
  });
});
