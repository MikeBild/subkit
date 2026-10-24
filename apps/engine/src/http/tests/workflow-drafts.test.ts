import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog, workflowsSchedules } from "../../db/schema/index.ts";
import { WorkflowDraftSchema } from "../../workflows/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
} from "./setup.ts";

let ctx: HttpTestServer;
const readKey = "wf_live_draft_read_only_test_key_00001";
const cliKey = "wf_live_clisess_draft_test_key_00000001";
beforeAll(async () => {
  ctx = await createHttpTestServer("workflow_drafts");
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    prefix: readKey.slice(0, 12),
    token_sha256: createHash("sha256").update(readKey).digest("hex"),
    scopes: ["workflow:read"],
  });
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    prefix: cliKey.slice(0, 12),
    token_sha256: createHash("sha256").update(cliKey).digest("hex"),
    scopes: ["workflow:read", "workflow:write"],
    credential_origin: "cli_oauth_session",
  });
});
afterAll(async () => {
  await ctx.cleanup();
});

function headers(key = ctx.apiKey) {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}
function definition(name: string, expression = "return 1;") {
  return {
    name,
    slug: name,
    trigger: { kind: "schedule", cron: "0 8 * * *" },
    steps: [{ kind: "transform", id: "result", expression }],
  };
}

test("draft create, reload and optimistic update never arm a schedule", async () => {
  const created = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ definition: definition("api-draft") }),
  });
  expect(created.status).toBe(201);
  const first = WorkflowDraftSchema.parse(await created.json());
  expect(first.current_version_id).toBeNull();
  const url = `${ctx.baseUrl}/v1/workflows/${first.workflow_id}/draft`;
  const read = await fetch(url, { headers: headers(readKey) });
  expect(read.status).toBe(200);
  expect(WorkflowDraftSchema.parse(await read.json())).toEqual(first);
  const body = {
    definition: definition("api-draft", "return 2;"),
    expected_draft_version_id: first.version_id,
  };
  const updated = await fetch(url, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });
  expect(updated.status).toBe(200);
  const second = WorkflowDraftSchema.parse(await updated.json());
  expect(second.version).toBe(2);
  expect(second.digest).not.toBe(first.digest);
  const stale = await fetch(url, { method: "PUT", headers: headers(), body: JSON.stringify(body) });
  expect(stale.status).toBe(409);
  expect(
    await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.tenant_id, ctx.tenantId)),
  ).toHaveLength(0);
  const events = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, first.workflow_id)));
  const writes = events.filter(
    (event) => (event.metadata as Record<string, unknown>).kind === "draft",
  );
  expect(writes).toHaveLength(2);
  expect(writes[0]?.actor_id).toBe(ctx.userId);
  expect(writes[0]?.metadata).toMatchObject({ request_source: "api" });
});

test("a draft based on an older version is refused once the CLI saved a newer one", async () => {
  const created = await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(definition("stale-base")),
  });
  expect(created.status).toBe(201);
  const first = (await created.json()) as { id: string; current_version_id: string };
  const cli = await fetch(`${ctx.baseUrl}/v1/workflows/${first.id}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(definition("stale-base", "return 2;")),
  });
  expect(cli.status).toBe(200);
  const second = (await cli.json()) as {
    current_version_id: string;
    current_version: number;
    draft_version_id: string | null;
  };
  expect(second.current_version).toBe(2);
  expect(second.draft_version_id).toBeNull();
  const url = `${ctx.baseUrl}/v1/workflows/${first.id}/draft`;
  const stale = await fetch(url, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({
      definition: definition("stale-base", "return 3;"),
      expected_draft_version_id: null,
      expected_current_version_id: first.current_version_id,
    }),
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    code: "conflict",
    details: {
      reason: "version_conflict",
      expected_current_version_id: first.current_version_id,
      current_version_id: second.current_version_id,
      current_version: 2,
    },
  });
  expect((await fetch(url, { headers: headers() })).status).toBe(404);
  const fresh = await fetch(url, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({
      definition: definition("stale-base", "return 3;"),
      expected_draft_version_id: null,
      expected_current_version_id: second.current_version_id,
    }),
  });
  expect(fresh.status).toBe(200);
  const draft = WorkflowDraftSchema.parse(await fresh.json());
  expect(draft.version).toBe(3);
  expect(draft.current_version_id).toBe(second.current_version_id);
});

test("draft routes require authentication, write permission and valid definitions", async () => {
  const url = `${ctx.baseUrl}/v1/workflows/drafts`;
  const body = JSON.stringify({ definition: definition("denied-draft") });
  expect(
    (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body }))
      .status,
  ).toBe(401);
  expect((await fetch(url, { method: "POST", headers: headers(readKey), body })).status).toBe(403);
  expect(
    (
      await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ definition: { name: "invalid", steps: [{ kind: "unknown" }] } }),
      })
    ).status,
  ).toBe(400);
  const created = await fetch(url, { method: "POST", headers: headers(), body });
  expect(created.status).toBe(201);
  const draft = WorkflowDraftSchema.parse(await created.json());
  const updateUrl = `${ctx.baseUrl}/v1/workflows/${draft.workflow_id}/draft`;
  const updateBody = JSON.stringify({
    definition: definition("denied-draft"),
    expected_draft_version_id: draft.version_id,
  });
  expect(
    (await fetch(updateUrl, { method: "PUT", headers: headers(readKey), body: updateBody })).status,
  ).toBe(403);
  expect((await fetch(updateUrl, { method: "PUT", headers: headers(), body })).status).toBe(400);
});

test("the derived limits reach every surface through one endpoint, and change nothing on their own", async () => {
  const created = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      definition: {
        name: "derive-limits",
        slug: "derive-limits",
        steps: [
          {
            kind: "request",
            id: "read_page",
            url: "https://api.example.test/v1/pages/${input.page_id}",
            method: "GET",
          },
        ],
      },
    }),
  });
  expect(created.status).toBe(201);
  const draft = (await created.json()) as { workflow_id: string; version_id: string };

  const empty = await fetch(`${ctx.baseUrl}/v1/workflows/${draft.workflow_id}/boundary-proposals`, {
    headers: headers(),
  });
  expect(empty.status).toBe(200);
  const nothing = (await empty.json()) as {
    proposals: unknown[];
    unproposable: Array<{ step_id: string; reason: string }>;
  };
  expect(nothing.proposals).toEqual([]);
  expect(nothing.unproposable).toEqual([{ step_id: "read_page", reason: "no_history" }]);

  const refused = await fetch(
    `${ctx.baseUrl}/v1/workflows/${draft.workflow_id}/boundary-proposals/apply`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ expected_draft_version_id: draft.version_id }),
    },
  );
  expect(refused.status).toBe(400);

  const readOnly = await fetch(
    `${ctx.baseUrl}/v1/workflows/${draft.workflow_id}/boundary-proposals`,
    { headers: headers(readKey) },
  );
  expect(readOnly.status).toBe(200);
  const denied = await fetch(
    `${ctx.baseUrl}/v1/workflows/${draft.workflow_id}/boundary-proposals/apply`,
    {
      method: "POST",
      headers: headers(readKey),
      body: JSON.stringify({ expected_draft_version_id: draft.version_id }),
    },
  );
  expect(denied.status).toBe(403);

  const after = await fetch(`${ctx.baseUrl}/v1/workflows/${draft.workflow_id}/draft`, {
    headers: headers(),
  });
  expect(((await after.json()) as { version_id: string }).version_id).toBe(draft.version_id);
});

function spec(goal: string, origin: "person" | "chat" | "derived" = "chat") {
  return {
    goal,
    inputs: [],
    outputs: [{ name: "report", description: "The weekly report" }],
    delivery: { channel: "email" },
    conventions_applied: [],
    evidence: [],
    open_questions: ["Which mailbox receives the report?"],
    origin,
  };
}

test("a draft spec round-trips through create, update and read, and stays with its tenant", async () => {
  const created = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ definition: definition("api-spec-draft"), spec: spec("First goal") }),
  });
  expect(created.status).toBe(201);
  const first = WorkflowDraftSchema.parse(await created.json());
  expect(first.spec).toEqual(spec("First goal"));
  const url = `${ctx.baseUrl}/v1/workflows/${first.workflow_id}/draft`;
  const updated = await fetch(url, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({
      definition: definition("api-spec-draft"),
      expected_draft_version_id: first.version_id,
      spec: spec("Second goal"),
    }),
  });
  expect(updated.status).toBe(200);
  const second = WorkflowDraftSchema.parse(await updated.json());
  expect(second.version).toBe(first.version + 1);
  expect(second.digest).toBe(first.digest);
  const read = await fetch(url, { headers: headers(readKey) });
  expect(WorkflowDraftSchema.parse(await read.json()).spec).toEqual(spec("Second goal"));
  const other = await createSecondaryTenant(ctx, "spec-draft");
  const foreign = await fetch(url, { headers: headers(other.admin.apiKey) });
  expect(foreign.status).toBe(404);
});

test("an invalid spec is refused with 400", async () => {
  const created = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      definition: definition("api-spec-invalid"),
      spec: { ...spec("Goal"), extra: true },
    }),
  });
  expect(created.status).toBe(400);
});

test("only a signed-in person can save a spec as stated by a person", async () => {
  const body = JSON.stringify({
    definition: definition("api-spec-person"),
    spec: spec("Person goal", "person"),
  });
  const viaKey = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
    method: "POST",
    headers: headers(),
    body,
  });
  expect(viaKey.status).toBe(403);
  const viaSession = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
    method: "POST",
    headers: await browserSessionHeaders(ctx, ctx.userId),
    body,
  });
  expect(viaSession.status).toBe(201);
  expect(WorkflowDraftSchema.parse(await viaSession.json()).spec?.origin).toBe("person");
});

test("a person signed in through sk can save a spec as stated by a person", async () => {
  const viaCli = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
    method: "POST",
    headers: headers(cliKey),
    body: JSON.stringify({
      definition: definition("api-spec-person-cli"),
      spec: spec("Person goal from sk", "person"),
    }),
  });
  expect(viaCli.status).toBe(201);
  expect(WorkflowDraftSchema.parse(await viaCli.json()).spec?.origin).toBe("person");
});
