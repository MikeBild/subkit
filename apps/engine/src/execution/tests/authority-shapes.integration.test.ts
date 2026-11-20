import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getCredentialForConnector, upsertCredential } from "../../credentials/service.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { connectors, credentials, workflowExecutionAuthorities } from "../../db/schema/index.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { workflowJsonDigest } from "../../workflows/canonical-json.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import {
  admitAuthorizedWorkflowExecution,
  assertExecutionAuthorityCurrent,
} from "../authority-admission.ts";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let sequence = 0;
const actor = "00000000-0000-4000-8000-000000000001";
const SECRET = "s3cr3t-query-token";
const STATIC_SECRET = "s3cr3t-static-partner";

beforeAll(async () => {
  ctx = await createEngineCtx("authority-shapes");
  mock = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true }));
});
afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

async function fixture(options: {
  step: Record<string, unknown>;
  static_query?: Record<string, unknown>;
  credential_query?: Record<string, string>;
  lead_in?: boolean;
}) {
  const slug = `authority-shapes-${++sequence}`;
  const db = ctx.testDb.db;
  const [connector] = await db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug,
      display_name: slug,
      driver: "http",
      auth_type: options.credential_query ? "query" : "none",
      environment: "dev",
      base_url: `${mock.baseUrl}/endpoint`,
      ...(options.static_query ? { config: { static_query: options.static_query } } : {}),
    })
    .returning();
  if (!connector) throw new Error("missing connector fixture");
  if (options.credential_query)
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: connector.id,
        environment: "dev",
        mode: "query",
        actor_id: null,
        value: { mode: "query", query: options.credential_query },
      },
      db,
    );
  const [plain] = options.lead_in
    ? await db
        .insert(connectors)
        .values({
          tenant_id: ctx.tenantId,
          slug: `${slug}-plain`,
          display_name: `${slug}-plain`,
          driver: "http",
          auth_type: "none",
          environment: "dev",
          base_url: `${mock.baseUrl}/plain`,
        })
        .returning()
    : [];
  const workflow = await createWorkflowRow(ctx, {
    name: slug,
    slug,
    steps: [
      ...(plain
        ? [{ id: "first", kind: "request", connector_id: plain.id, method: "GET", path: "/first" }]
        : []),
      {
        id: "call",
        kind: "request",
        connector_id: connector.id,
        ...(plain ? { depends_on: ["first"] } : {}),
        ...options.step,
      },
    ],
  });
  const reference = {
    tenant_id: ctx.tenantId,
    workflow_id: workflow.workflow_id,
    workflow_version_id: workflow.version_id,
    execution_environment: "dev" as const,
  };
  const preview = await previewWorkflowAuthority(reference, db);
  const grant = async () => {
    const now = await databaseNow(db);
    const [authority] = await db
      .insert(workflowExecutionAuthorities)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id: workflow.workflow_id,
        workflow_version_id: workflow.version_id,
        effect_manifest_digest: preview.digest,
        effect_manifest: { ...preview.manifest },
        target_constraints: {
          targets: preview.manifest.effects.flatMap((effect) =>
            effect.target ? [effect.target] : [],
          ),
        },
        execution_environment: "dev",
        valid_from: new Date(now.getTime() - 60_000),
        valid_until: new Date(now.getTime() + 60 * 60_000),
        max_runs: 10,
        created_by: actor,
      })
      .returning();
    if (!authority) throw new Error("missing authority fixture");
    return authority;
  };
  const admit = (input: Record<string, unknown> = {}) =>
    admitAuthorizedWorkflowExecution(
      {
        tenant_id: ctx.tenantId,
        workflow_id: workflow.workflow_id,
        execution_environment: "dev",
        request_source: "api",
        input,
      },
      db,
    );
  const runAdmitted = (execution_id: string, input: Record<string, unknown> = {}) =>
    runExecution({
      db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflow.workflow_id },
      input,
      options: { existing_execution_id: execution_id },
    });
  return {
    connector,
    preview,
    reference,
    grant,
    admit,
    runAdmitted,
    async run(input: Record<string, unknown> = {}) {
      const admitted = await admit(input);
      return runAdmitted(admitted.execution_id, input);
    },
  };
}

async function refusalAudit(execution_id: string) {
  return ctx.testDb.db
    .select({ reason: auditLog.reason, result: auditLog.result, metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, "execution.boundary_refused"),
        eq(auditLog.resource_id, execution_id),
      ),
    );
}

const QUERY_STEP = {
  method: "GET",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: runtime target boundary fixture
  path: "/sites/${input.site}/stats",
  query: { tz: "UTC" },
  boundary: {
    variables: { "input.site": { enum: ["alpha"] } },
    max_body_bytes: 0,
    max_calls: 1,
  },
};

test("a step on a connector that adds query parameters is approvable and runs within them", async () => {
  const f = await fixture({
    step: QUERY_STEP,
    static_query: { format: "json", partner: STATIC_SECRET },
    credential_query: { api_key: SECRET },
  });
  expect(f.preview.request_refusals).toEqual([]);
  expect(f.preview.manifest.issues).toEqual([]);
  expect(f.preview.eligible_for_repeated_runs).toBe(true);
  expect(f.preview.manifest.effects[0]?.boundary?.connector_query).toEqual({
    fixed: { format: workflowJsonDigest("json"), partner: workflowJsonDigest(STATIC_SECRET) },
    credential: ["api_key"],
  });
  expect(JSON.stringify(f.preview)).not.toContain(SECRET);
  expect(JSON.stringify(f.preview)).not.toContain(STATIC_SECRET);
  await f.grant();
  const reached: string[] = [];
  mock.setHandler((req, res) => {
    reached.push(String(req.url));
    jsonResponse(res, 200, { ok: true });
  });
  const result = await f.run({ site: "alpha" });
  expect(result.status).toBe("succeeded");
  expect(reached).toHaveLength(1);
  const sent = new URL(`http://fixture${reached[0]}`);
  expect(sent.pathname).toBe("/endpoint/sites/alpha/stats");
  expect(Object.fromEntries(sent.searchParams)).toEqual({
    tz: "UTC",
    format: "json",
    partner: STATIC_SECRET,
    api_key: SECRET,
  });
});

test("the approval is pinned to the connector's own query keys", async () => {
  const digests = new Set<string>();
  for (const shape of [
    { static_query: { format: "json" }, credential_query: { api_key: SECRET } },
    { static_query: { format: "xml" }, credential_query: { api_key: SECRET } },
    { static_query: { format: "json" }, credential_query: { key: SECRET } },
    { static_query: { format: "json" } },
    { credential_query: { api_key: SECRET } },
    {},
  ]) {
    const f = await fixture({ step: QUERY_STEP, ...shape });
    expect(f.preview.eligible_for_repeated_runs).toBe(true);
    digests.add(f.preview.digest);
  }
  expect(digests.size).toBe(6);
});

test("a connector key that collides with the step, or cannot be read, keeps the step unapproved", async () => {
  const collision = await fixture({ step: QUERY_STEP, static_query: { tz: "CET" } });
  expect(collision.preview.request_refusals).toEqual([
    { step_id: "call", reason: "connector_query_conflict" },
  ]);
  expect(collision.preview.eligible_for_repeated_runs).toBe(false);

  const unnamed = await fixture({ step: QUERY_STEP, static_query: { "": "x" } });
  expect(unnamed.preview.request_refusals).toEqual([
    { step_id: "call", reason: "connector_query_unresolved" },
  ]);
  expect(unnamed.preview.eligible_for_repeated_runs).toBe(false);

  const nothing = await fixture({ step: QUERY_STEP, static_query: [] as never });
  expect(nothing.preview.request_refusals).toEqual([]);
  expect(nothing.preview.eligible_for_repeated_runs).toBe(true);
  expect(nothing.preview.manifest.effects[0]?.boundary?.connector_query).toBeUndefined();

  const missing = await fixture({ step: QUERY_STEP, credential_query: { api_key: SECRET } });
  await ctx.testDb.db
    .update(credentials)
    .set({ deleted_at: await databaseNow(ctx.testDb.db) })
    .where(
      and(
        eq(credentials.tenant_id, ctx.tenantId),
        eq(credentials.connector_id, missing.connector.id),
      ),
    );
  const unreadable = await previewWorkflowAuthority(missing.reference, ctx.testDb.db);
  expect(unreadable.request_refusals).toEqual([
    { step_id: "call", reason: "connector_query_unresolved" },
  ]);
  expect(unreadable.eligible_for_repeated_runs).toBe(false);
});

test("dispatch refuses every query the approved boundary does not describe", async () => {
  const f = await fixture({
    step: QUERY_STEP,
    static_query: { format: "json" },
    credential_query: { api_key: SECRET },
  });
  const authority = await f.grant();
  const effect = (
    authority.effect_manifest as {
      effects: Array<{ step_id: string; configuration_digest: string }>;
    }
  ).effects.find((entry) => entry.step_id === "call");
  if (!effect) throw new Error("missing granted effect");
  const stored = await getCredentialForConnector(
    ctx.tenantId,
    f.connector.id,
    "dev",
    ctx.testDb.db,
  );
  if (!stored) throw new Error("missing credential fixture");
  const admitted = await f.admit({ site: "alpha" });
  const check = (query: string) =>
    assertExecutionAuthorityCurrent(ctx.testDb.db, ctx.tenantId, admitted.execution_id, {
      step_id: effect.step_id,
      configuration_digest: effect.configuration_digest,
      credential_id: stored.row.id,
      credential_revision: stored.row.authority_revision,
      connection_authority: null,
      request: {
        method: "GET",
        url: `${mock.baseUrl}/endpoint/sites/alpha/stats?${query}`,
        headers: {},
        body: null,
      },
    });
  await expect(check(`tz=UTC&format=json&api_key=${SECRET}`)).resolves.toBeDefined();
  await expect(check("tz=UTC&format=json&api_key=rotated-value")).resolves.toBeDefined();
  for (const query of [
    "tz=UTC&format=json",
    `tz=UTC&api_key=${SECRET}`,
    `tz=UTC&format=xml&api_key=${SECRET}`,
    `tz=UTC&format=json&api_key=${SECRET}&debug=1`,
    `tz=UTC&format=json&api_key=${SECRET}&api_key=${SECRET}`,
    `tz=CET&format=json&api_key=${SECRET}`,
  ])
    await expect(check(query)).rejects.toMatchObject({ code: "execution_authority_changed" });
});

test("a connector that starts adding another parameter during a run is refused with an audit row", async () => {
  const f = await fixture({
    step: QUERY_STEP,
    static_query: { format: "json" },
    credential_query: { api_key: SECRET },
    lead_in: true,
  });
  expect(f.preview.eligible_for_repeated_runs).toBe(true);
  await f.grant();
  const reached: string[] = [];
  mock.setHandler(async (req, res) => {
    reached.push(String(req.url));
    await ctx.testDb.db
      .update(connectors)
      .set({ config: { static_query: { format: "json", debug: "1" } } })
      .where(eq(connectors.id, f.connector.id));
    jsonResponse(res, 200, { ok: true });
  });
  const admitted = await f.admit({ site: "alpha" });
  const result = await f.runAdmitted(admitted.execution_id, { site: "alpha" });
  expect(result.status).toBe("failed");
  expect(reached).toEqual(["/plain/first"]);
  expect(result.steps.find((step) => step.step_key === "call")?.error).toMatchObject({
    code: "execution_authority_changed",
  });
  const rows = await refusalAudit(admitted.execution_id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ result: "denied", reason: "execution_authority_changed" });
  expect(JSON.stringify(rows)).not.toContain(SECRET);
});

async function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

const BODY_PAGED_STEP = {
  method: "POST",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: runtime target boundary fixture
  path: "/sites/${input.site}/search",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: runtime body boundary fixture
  body: { filter: "${input.filter}" },
  pagination: {
    strategy: "cursor",
    cursor_request_param: "cursor",
    cursor_response_path: "$.next",
    items_path: "$.items",
    limit_param: "limit",
    page_size: 2,
    max_pages: 3,
    parameter_location: "body",
  },
  boundary: {
    variables: { "input.site": { enum: ["alpha"] } },
    max_body_bytes: 120,
    max_calls: 1,
  },
};

test("a step that pages through the body is approvable and moves only its paging fields", async () => {
  const f = await fixture({ step: BODY_PAGED_STEP });
  expect(f.preview.request_refusals).toEqual([]);
  expect(f.preview.manifest.issues).toEqual([]);
  expect(f.preview.eligible_for_repeated_runs).toBe(true);
  expect(f.preview.manifest.effects[0]?.boundary?.pagination).toEqual({
    params: ["cursor", "limit"],
    max_requests: 3,
    location: "body",
  });
  await f.grant();
  const bodies: unknown[] = [];
  mock.setHandler(async (req, res) => {
    const body = (await readJson(req)) as { cursor?: string };
    bodies.push(body);
    jsonResponse(res, 200, {
      items: [{ id: bodies.length }, { id: `${bodies.length}b` }],
      next: body.cursor === "p2" ? null : "p2",
    });
  });
  const result = await f.run({ site: "alpha", filter: "open" });
  expect(result.status).toBe("succeeded");
  expect(bodies).toEqual([
    { filter: "open", limit: 2 },
    { filter: "open", limit: 2, cursor: "p2" },
  ]);
});

test("body paging without a page ceiling, or on a body the paging cannot be read from, stays unapproved", async () => {
  for (const [step, reason] of [
    [
      {
        ...BODY_PAGED_STEP,
        pagination: { ...BODY_PAGED_STEP.pagination, max_pages: undefined },
      },
      "pagination_unbounded",
    ],
    [{ ...BODY_PAGED_STEP, body: { cursor: "start" } }, "pagination_param_conflict"],
    [{ ...BODY_PAGED_STEP, body: ["open"] }, "pagination_body_unsupported"],
  ] as const) {
    const f = await fixture({ step });
    expect(f.preview.request_refusals).toEqual([{ step_id: "call", reason }]);
    expect(f.preview.eligible_for_repeated_runs).toBe(false);
  }
});

test("a later page outside the approved boundary is refused before it is sent, with an audit row", async () => {
  const f = await fixture({ step: BODY_PAGED_STEP });
  await f.grant();
  let requests = 0;
  mock.setHandler(async (req, res) => {
    requests++;
    await readJson(req);
    jsonResponse(res, 200, { items: [{ id: 1 }, { id: 2 }], next: "c".repeat(400) });
  });
  const admitted = await f.admit({ site: "alpha", filter: "open" });
  const result = await f.runAdmitted(admitted.execution_id, { site: "alpha", filter: "open" });
  expect(result.status).toBe("failed");
  expect(requests).toBe(1);
  expect(result.steps.find((step) => step.step_key === "call")?.error).toMatchObject({
    code: "execution_authority_changed",
  });
  const rows = await refusalAudit(admitted.execution_id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ result: "denied", reason: "execution_authority_changed" });
});

test("dispatch refuses every paged body the approved boundary does not describe", async () => {
  const f = await fixture({ step: BODY_PAGED_STEP });
  const authority = await f.grant();
  const effect = (
    authority.effect_manifest as {
      effects: Array<{ step_id: string; configuration_digest: string }>;
    }
  ).effects.find((entry) => entry.step_id === "call");
  if (!effect) throw new Error("missing granted effect");
  const admitted = await f.admit({ site: "alpha", filter: "open" });
  const check = (body: unknown, query = "") =>
    assertExecutionAuthorityCurrent(ctx.testDb.db, ctx.tenantId, admitted.execution_id, {
      step_id: effect.step_id,
      configuration_digest: effect.configuration_digest,
      credential_id: null,
      credential_revision: null,
      connection_authority: null,
      request: {
        method: "POST",
        url: `${mock.baseUrl}/endpoint/sites/alpha/search${query}`,
        headers: {},
        body: body as never,
      },
    });
  await expect(check({ filter: "open", limit: 2 })).resolves.toBeDefined();
  await expect(check({ filter: "open", limit: 2, cursor: "p2" })).resolves.toBeDefined();
  for (const body of [
    null,
    "cursor=p2",
    [{ filter: "open" }],
    { filter: "open", cursor: { $gt: "" } },
    { filter: "open", limit: [2] },
    { filter: "x".repeat(200), limit: 2 },
  ])
    await expect(check(body)).rejects.toMatchObject({ code: "execution_authority_changed" });
  await expect(check({ filter: "open", limit: 2 }, "?cursor=p2")).rejects.toMatchObject({
    code: "execution_authority_changed",
  });
});

const READ_PATH_STEP = {
  method: "GET",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: runtime target boundary fixture
  path: "/sites/${input.site}/stats",
};
const READ_QUERY_STEP = {
  method: "GET",
  path: "/stats",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: runtime target boundary fixture
  query: { site: "${input.site}" },
};

test("a read without a boundary on a connector that adds query parameters asks for a boundary", async () => {
  for (const step of [READ_PATH_STEP, READ_QUERY_STEP])
    for (const shape of [
      { credential_query: { api_key: SECRET } },
      { static_query: { format: "json" } },
    ]) {
      const f = await fixture({ step, ...shape });
      expect(f.preview.request_refusals).toEqual([
        { step_id: "call", reason: "connector_query_needs_boundary" },
      ]);
      expect(f.preview.manifest.effects[0]?.read_path).toBeUndefined();
      expect(f.preview.manifest.issues).toEqual([{ step_id: "call", code: "dynamic_request" }]);
      expect(f.preview.eligible_for_repeated_runs).toBe(false);
    }
});

test("the same reads stay approvable on a connector that adds nothing, and with a boundary", async () => {
  for (const step of [READ_PATH_STEP, READ_QUERY_STEP]) {
    const plain = await fixture({ step });
    expect(plain.preview.request_refusals).toEqual([]);
    expect(plain.preview.eligible_for_repeated_runs).toBe(true);
  }
  const bounded = await fixture({
    step: {
      ...READ_PATH_STEP,
      boundary: {
        variables: { "input.site": { enum: ["alpha"] } },
        max_body_bytes: 0,
        max_calls: 1,
      },
    },
    credential_query: { api_key: SECRET },
  });
  expect(bounded.preview.eligible_for_repeated_runs).toBe(true);
  await bounded.grant();
  mock.setHandler((_, res) => jsonResponse(res, 200, { ok: true }));
  expect((await bounded.run({ site: "alpha" })).status).toBe("succeeded");
});

test("a fixed read on a connector that adds query parameters needs no boundary and runs", async () => {
  const f = await fixture({
    step: { method: "GET", path: "/stats" },
    credential_query: { api_key: SECRET },
    static_query: { format: "json" },
  });
  expect(f.preview.request_refusals).toEqual([]);
  expect(f.preview.eligible_for_repeated_runs).toBe(true);
  await f.grant();
  const reached: string[] = [];
  mock.setHandler((req, res) => {
    reached.push(String(req.url));
    jsonResponse(res, 200, { ok: true });
  });
  expect((await f.run()).status).toBe("succeeded");
  expect(reached).toEqual([`/endpoint/stats?format=json&api_key=${SECRET}`]);
});

test("the paging loop stops a body-paged step at its approved page ceiling", async () => {
  const f = await fixture({ step: BODY_PAGED_STEP });
  await f.grant();
  let requests = 0;
  mock.setHandler(async (req, res) => {
    requests++;
    await readJson(req);
    jsonResponse(res, 200, { items: [{ id: requests }, { id: -requests }], next: `p${requests}` });
  });
  const result = await f.run({ site: "alpha", filter: "open" });
  expect(requests).toBe(3);
  expect(result.status).toBe("failed");
  expect(result.steps.find((step) => step.step_key === "call")?.error).toMatchObject({
    code: "pagination_limit_reached",
  });
});
