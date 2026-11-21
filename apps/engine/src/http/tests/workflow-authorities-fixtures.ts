import { afterAll, beforeAll, expect } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import {
  apiKeys,
  connectors,
  conversations,
  executions,
  sessions,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createBoss, disposeBoss } from "../../queue/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { workflowJsonDigest } from "../../workflows/canonical-json.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

export let ctx: HttpTestServer;

export let app: ReturnType<typeof createApp>;

export let browserHeaders: Record<string, string>;

let counter = 0;

export function nextCounter(): number {
  counter += 1;
  return counter;
}

export let remote: MockServer;

export let boss: PgBoss;

export async function fixture(baseUrl = "https://example.test/api", repairable = false) {
  const slug = `authority-http-${++counter}`;
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug,
      display_name: slug,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: baseUrl,
    })
    .returning();
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: ctx.tenantId, slug, name: slug, lifecycle: "draft" })
    .returning();
  if (!workflow || !connector) throw new Error("missing workflow fixture");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: slug,
        steps: [
          {
            id: "send",
            ...(repairable ? { data_selector: "$.data.id" } : {}),
            kind: "request",
            connector_id: connector.id,
            method: "POST",
            path: "/messages",
            body: { recipient: "reviewed@example.test" },
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("missing version fixture");
  const base = `/v1/workflows/${workflow.id}`;
  const previewPath = `${base}/versions/${version.id}/authority-preview`;
  const preview = await app.request(previewPath, {
    headers: { authorization: `Bearer ${ctx.apiKey}` },
  });
  expect(preview.status).toBe(200);
  const body = (await preview.json()) as {
    digest: string;
    execution_shape: unknown;
    suggested_bounds: { valid_from: string; valid_until: string; max_runs: number };
  };
  expect(body.execution_shape).toMatchObject({
    requests: [
      {
        step_id: "send",
        target: { method: "POST", url: `${baseUrl}/messages` },
        retry_policy_max_attempts: 5,
      },
    ],
    iterations: [],
    run_limit_is_request_limit: false,
  });
  expect(JSON.stringify(body.execution_shape)).toContain("reviewed@example.test");
  return {
    workflow,
    version,
    base,
    previewPath,
    connector,
    body: {
      workflow_version_id: version.id,
      execution_environment: "dev",
      expected_manifest_digest: body.digest,
      ...body.suggested_bounds,
    },
  };
}

export async function readOnlyKey(tenant_id = ctx.tenantId, user_id = ctx.userId) {
  const token = `wf_live_${String(++counter).padStart(4, "0")}_authority_history_reader`;
  await ctx.db.insert(apiKeys).values({
    tenant_id,
    user_id,
    prefix: token.slice(0, 12),
    token_sha256: createHash("sha256").update(token).digest("hex"),
    scopes: ["workflow:read"],
  });
  return { authorization: `Bearer ${token}` };
}

export async function pendingLiveTest(f: Awaited<ReturnType<typeof fixture>>) {
  await ctx.db
    .update(workflows)
    .set({ draft_version_id: f.version.id })
    .where(eq(workflows.id, f.workflow.id));
  const input = {};
  const [conversation] = await ctx.db
    .insert(conversations)
    .values({
      tenant_id: ctx.tenantId,
      owner_id: ctx.userId,
      status: "active",
      draft: {
        workflow: { name: "Pending test", steps: [] },
        session: {
          live_test: {
            workflow_id: f.workflow.id,
            workflow_version_id: f.version.id,
            environment: "dev",
            input,
            input_digest: workflowJsonDigest(input),
            idempotency_key: `pending:${f.workflow.id}`,
            state: "pending",
          },
        },
      },
    })
    .returning();
  if (!conversation) throw new Error("missing conversation");
  const runs = async () =>
    (await ctx.db.select().from(executions).where(eq(executions.workflow_id, f.workflow.id)))
      .length;
  return { conversation_id: conversation.id, runs };
}

export function setupWorkflowAuthorities(): void {
  counter = 0;
  beforeAll(async () => {
    ctx = await createHttpTestServer("workflow_authorities");
    boss = await createBoss({ connectionString: ctx.testDb.url });
    app = createApp({ db: ctx.db, registry: buildDefaultRegistry(ctx.db), boss });
    remote = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true }));
    const [session] = await ctx.db
      .insert(sessions)
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        expires_at: new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live browser fixture
        absolute_expires_at: new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live browser fixture
      })
      .returning();
    if (!session) throw new Error("missing browser session fixture");
    const payload = { tenant_id: ctx.tenantId, user_id: ctx.userId, session_id: session.id };
    browserHeaders = {
      cookie: browserSessionCookie(await signBrowserSession(payload)),
      "x-subkit-csrf": await signBrowserCsrf(payload),
      "content-type": "application/json",
    };
  });
  afterAll(async () => {
    await remote.close();
    await disposeBoss(boss);
    await ctx.cleanup();
  });
}
