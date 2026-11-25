import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import { apiKeys, sessions, users, workflows, workflowVersions } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const STORED_TOKEN = "monday-personal-token-573";
const RECIPE_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const BOARDS = [
  { id: "101", name: "Roadmap", state: "active" },
  { id: "102", name: "Archive", state: "archived" },
];

let ctx: JourneyCtx;
let monday: Server;
let mondayBase = "";
let memberApiKey = "";
let browser: Record<string, string> = {};
const received: Array<{ authorization: string | undefined; query: string }> = [];

const boardQueries = () => received.filter((request) => request.query.includes("boards("));

function memberFetch(path: string, init: RequestInit = {}) {
  return fetch(`${ctx.baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${memberApiKey}`, "content-type": "application/json" },
  });
}

async function storeToken(connectorId: string) {
  const stored = await journeyFetch(ctx, `/v1/connectors/${connectorId}/credentials`, {
    method: "POST",
    body: JSON.stringify({ mode: "bearer", token: STORED_TOKEN }),
  });
  expect(stored.status).toBe(201);
}

async function connectorFromPost(): Promise<string> {
  const created = await journeyFetch(ctx, "/v1/connectors", {
    method: "POST",
    body: JSON.stringify({
      name: "Monday",
      slug: "monday-direct",
      driver: "graphql",
      environment: "dev",
      auth_type: "bearer",
      base_url: mondayBase,
      template_slug: "monday",
    }),
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

async function connectorFromTemplate(): Promise<string> {
  const created = await journeyFetch(ctx, "/v1/connectors/from-template/monday", {
    method: "POST",
    body: JSON.stringify({ name: "Monday from template", environment: "dev", ingest_now: false }),
  });
  expect(created.status).toBe(201);
  const connectorId = ((await created.json()) as { id: string }).id;
  const patched = await journeyFetch(ctx, `/v1/connectors/${connectorId}`, {
    method: "PATCH",
    body: JSON.stringify({ base_url: mondayBase }),
  });
  expect(patched.status).toBe(200);
  return connectorId;
}

async function saveRecipeFromChat(connectorId: string, slug: string): Promise<string> {
  const created = await journeyFetch(ctx, "/v1/conversations", {
    method: "POST",
    body: JSON.stringify({ connector_id: connectorId }),
  });
  expect(created.status).toBe(201);
  const conversationId = ((await created.json()) as { conversation: { id: string } }).conversation
    .id;
  getMockProvider().setConversePlan(conversationId, [
    {
      tool: "start_workflow_from_recipe",
      args: {
        template_slug: "monday",
        recipe_slug: "list-boards",
        slug,
        connector_bindings: { [RECIPE_PLACEHOLDER]: connectorId },
      },
    },
    { tool: "inspect_workflow_draft", args: {} },
    { tool: "validate_draft", args: {} },
    { tool: "dry_run_workflow", args: { input: {} } },
    { tool: "save_workflow_draft", args: {} },
    { text: "The Monday board list is saved." },
  ]);
  const turn = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message: "Create a workflow that lists my Monday boards" }),
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
  const [row] = await ctx.db
    .select({ id: workflows.id, draft: workflows.draft_version_id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.slug, slug)));
  expect(row?.draft).toBeTruthy();
  const [version] = await ctx.db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(eq(workflowVersions.id, row?.draft ?? ""));
  const savedSteps = (version?.dag as { steps?: Array<{ connector_id?: string }> } | undefined)
    ?.steps;
  expect(savedSteps).toBeDefined();
  expect(savedSteps?.map((step) => step.connector_id)).toEqual([connectorId]);
  return approve(row?.id ?? "", row?.draft ?? "", conversationId);
}

async function approve(workflowId: string, versionId: string, conversationId: string) {
  const preview = await journeyFetch(
    ctx,
    `/v1/workflows/${workflowId}/versions/${versionId}/authority-preview?environment=dev`,
  );
  expect(preview.status).toBe(200);
  const body = (await preview.json()) as {
    digest: string;
    suggested_bounds: { valid_from: string; valid_until: string };
  };
  const approved = await fetch(`${ctx.baseUrl}/v1/workflows/${workflowId}/execution-authorities`, {
    method: "POST",
    headers: browser,
    body: JSON.stringify({
      workflow_version_id: versionId,
      execution_environment: "dev",
      expected_manifest_digest: body.digest,
      valid_from: body.suggested_bounds.valid_from,
      valid_until: body.suggested_bounds.valid_until,
      max_runs: 1,
      activation: { expected_current_version_id: null },
      conversation_id: conversationId,
    }),
  });
  expect(approved.status).toBe(201);
  return `${workflowId}:${((await approved.json()) as { id: string }).id}`;
}

async function memberRuns(approval: string) {
  const [workflowId, authorityId] = approval.split(":");
  const before = boardQueries().length;
  const started = await memberFetch("/v1/executions", {
    method: "POST",
    body: JSON.stringify({
      source: "saved",
      workflow_id: workflowId,
      execution_authority_id: authorityId,
      idempotency_key: `member-${workflowId}`,
      input: {},
    }),
  });
  expect(started.status).toBe(200);
  const result = (await started.json()) as { execution_id: string; status: string };
  expect(result.status).toBe("succeeded");
  const runQueries = boardQueries().slice(before);
  expect(runQueries).toHaveLength(1);
  expect(runQueries[0]?.authorization).toBe(`Bearer ${STORED_TOKEN}`);
  const steps = await journeyFetch(ctx, `/v1/executions/${result.execution_id}/steps`);
  expect(steps.status).toBe(200);
  const stepsText = JSON.stringify(await steps.json());
  expect(stepsText).toContain("Roadmap");
  expect(stepsText).toContain("Archive");
}

beforeAll(async () => {
  ctx = await createJourneyCtx("monday-list-boards-recipe-auth");
  monday = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const query = ((): string => {
        try {
          return String((JSON.parse(body) as { query?: unknown }).query ?? "");
        } catch {
          return "";
        }
      })();
      received.push({ authorization: req.headers.authorization, query });
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== `Bearer ${STORED_TOKEN}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ errors: [{ message: "Not Authenticated" }] }));
        return;
      }
      res.end(JSON.stringify({ data: { boards: BOARDS } }));
    });
  });
  await new Promise<void>((resolve) => monday.listen(0, "127.0.0.1", () => resolve()));
  mondayBase = `http://127.0.0.1:${(monday.address() as AddressInfo).port}/v2`;

  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member@monday-recipe.test",
      role_id: ctx.rbacRoleIds.member,
    })
    .returning();
  if (!member) throw new Error("failed to seed member user");
  memberApiKey = "wf_live_monday573member0000000000000000";
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: member.id,
    prefix: memberApiKey.slice(0, 12),
    token_sha256: createHash("sha256").update(memberApiKey).digest("hex"),
    scopes: ["*"],
  });

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
  if (monday) await new Promise<void>((resolve) => monday.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("the shipped Monday list boards recipe sends the stored token", () => {
  test("a connector created directly authenticates the member's run", async () => {
    const connectorId = await connectorFromPost();
    await storeToken(connectorId);
    await memberRuns(await saveRecipeFromChat(connectorId, "monday-boards-direct"));
  });

  test("a connector created from the template authenticates the member's run", async () => {
    const connectorId = await connectorFromTemplate();
    await storeToken(connectorId);
    await memberRuns(await saveRecipeFromChat(connectorId, "monday-boards-template"));
  });

  test("no board query ever reached the provider without the stored token", () => {
    expect(boardQueries().length).toBeGreaterThanOrEqual(2);
    expect(boardQueries().every((q) => q.authorization === `Bearer ${STORED_TOKEN}`)).toBe(true);
  });
});
