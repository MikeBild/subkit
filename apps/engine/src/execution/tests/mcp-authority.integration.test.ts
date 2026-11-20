// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the steps below carry authored
// placeholder tokens verbatim.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getConnectorForEnvironment } from "../../connectors/service.ts";
import { closeDb } from "../../db/client.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { workflowExecutionAuthorities } from "../../db/schema/index.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { authorityConnectorDigest } from "../../workflows/authority-configuration.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { mcpToolDescriptorPin } from "../../workflows/mcp-boundary.ts";
import {
  admitAuthorizedWorkflowExecution,
  assertExecutionAuthorityCurrent,
} from "../authority-admission.ts";
import { runExecution } from "../engine.ts";
import { insertStepRow } from "../state.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let connectorId: string;
let sequence = 0;
const actor = "00000000-0000-4000-8000-000000000001";
const originalDatabaseUrl = process.env.DATABASE_URL;
const SERVER = "https://tools.mcpauthority.example.com/mcp";

const SEARCH = {
  name: "search",
  description: "search the index",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const PIN = mcpToolDescriptorPin(SEARCH);

const remote = {
  connects: 0,
  tools: [SEARCH] as Array<Record<string, unknown>>,
  calls: [] as Array<{ name: string; arguments: Record<string, unknown> | undefined }>,
};

const fakeClient: McpClientLike = {
  async connect() {
    remote.connects++;
  },
  async listTools() {
    return { tools: remote.tools };
  },
  async callTool(params) {
    remote.calls.push({ name: params.name, arguments: params.arguments });
    return { content: [{ type: "text", text: "ok" }], isError: false };
  },
  async readResource(params) {
    return { contents: [{ uri: params.uri, text: "resource body" }] };
  },
  async getPrompt() {
    return { messages: [] };
  },
  async close() {},
};

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  ctx = await createEngineCtx("mcp-authority");
  await closeDb();
  process.env.DATABASE_URL = ctx.testDb.url;
  const server = await seedMcpConnector(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    slug: "mcpauthority",
    display_name: "MCP Authority",
    environment: "dev",
    transport: "http",
    url: SERVER,
  });
  connectorId = server.id;
}, 30_000);

beforeEach(() => {
  remote.tools = [SEARCH];
  remote.calls = [];
  __resetMcpClientPoolForTests();
  remote.connects = 0;
});

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

const boundary = (over: Record<string, unknown> = {}) => ({
  effect: "read",
  variables: { "input.q": { enum: ["alpha", "beta"] } },
  max_calls: 1,
  descriptor: { input_schema_digest: PIN.input_schema_digest, annotations: PIN.annotations },
  ...over,
});

const toolStep = (mcp: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id: "call",
  kind: "request",
  mcp: {
    operation: "call_tool",
    tool: "search",
    arguments: { q: "${input.q}", mode: "exact" },
    boundary: boundary(),
    ...mcp,
  },
  ...extra,
});

async function fixture(step: Record<string, unknown>, lead?: Record<string, unknown>) {
  const slug = `mcp-authority-${++sequence}`;
  const db = ctx.testDb.db;
  const workflow = await createWorkflowRow(ctx, {
    name: slug,
    slug,
    steps: [
      ...(lead ? [{ ...lead, connector_id: connectorId }] : []),
      { ...step, connector_id: connectorId },
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
  const admit = (input: Record<string, unknown>) =>
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
  const runAdmitted = (execution_id: string, input: Record<string, unknown>) =>
    runExecution({
      db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflow.workflow_id },
      input,
      options: { existing_execution_id: execution_id },
    });
  return {
    preview,
    reference,
    grant,
    admit,
    runAdmitted,
    async run(input: Record<string, unknown>) {
      const admitted = await admit(input);
      return { admitted, result: await runAdmitted(admitted.execution_id, input) };
    },
  };
}

async function refusalAudit(execution_id: string) {
  return ctx.testDb.db
    .select({ reason: auditLog.reason, result: auditLog.result })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, "execution.boundary_refused"),
        eq(auditLog.resource_id, execution_id),
      ),
    );
}

test("a bounded tool call is approvable with the stated effect and runs within its boundary", async () => {
  const f = await fixture(toolStep());
  expect(f.preview.request_refusals).toEqual([]);
  expect(f.preview.manifest.issues).toEqual([]);
  expect(f.preview.eligible_for_repeated_runs).toBe(true);
  expect(f.preview.manifest.effects[0]).toMatchObject({
    driver: "mcp",
    effect: "read",
    operation: "tools/call:search",
    target: `${SERVER}#search`,
    mcp: { tool: "search", effect: "read", max_calls: 1, descriptor: PIN },
  });
  await f.grant();
  const { result } = await f.run({ q: "alpha" });
  expect(result.status).toBe("succeeded");
  expect(remote.calls).toEqual([{ name: "search", arguments: { q: "alpha", mode: "exact" } }]);
});

test("a tool call whose effect is not stated is approved as a write, and only for one attempt", async () => {
  const f = await fixture(
    toolStep({ boundary: boundary({ effect: undefined }) }, { max_retries: 0 }),
  );
  expect(f.preview.eligible_for_repeated_runs).toBe(true);
  expect(f.preview.manifest.effects[0]?.effect).toBe("write");
  await f.grant();
  const { result } = await f.run({ q: "alpha" });
  expect(result.status).toBe("succeeded");
  expect(remote.calls).toHaveLength(1);

  for (const extra of [{}, { max_retries: 2 }]) {
    const retried = await fixture(toolStep({ boundary: boundary({ effect: "write" }) }, extra));
    expect(retried.preview.request_refusals).toEqual([
      { step_id: "call", reason: "mcp_write_needs_single_attempt" },
    ]);
    expect(retried.preview.eligible_for_repeated_runs).toBe(false);
  }
});

test("the tool's description comes from the session that carries the call, with one handshake", async () => {
  const f = await fixture(toolStep());
  await f.grant();
  expect(remote.connects).toBe(0);
  expect((await f.run({ q: "alpha" })).result.status).toBe("succeeded");
  expect((await f.run({ q: "beta" })).result.status).toBe("succeeded");
  expect(remote.calls).toHaveLength(2);
  expect(remote.connects).toBe(1);
});

test("a tool call without a boundary keeps an unknown effect and is not approvable", async () => {
  const f = await fixture(toolStep({ boundary: undefined }));
  expect(f.preview.request_refusals).toEqual([{ step_id: "call", reason: "mcp_no_boundary" }]);
  expect(f.preview.manifest.effects[0]?.effect).toBe("unknown");
  expect(f.preview.manifest.issues.map((issue) => issue.code)).toContain("unknown_effect");
  expect(f.preview.eligible_for_repeated_runs).toBe(false);
});

test("each unbounded variant of a tool call stays unapproved with its reason", async () => {
  for (const [mcp, reason] of [
    [{ tool: "${input.tool}" }, "mcp_tool_not_literal"],
    [{ arguments: { q: "find ${input.q}" } }, "mcp_argument_placeholder_unsupported"],
    [{ arguments: { q: "${input.q}", extra: "${input.extra}" } }, "mcp_variables_mismatch"],
    [{ boundary: boundary({ variables: {} }) }, "mcp_variables_mismatch"],
  ] as const) {
    const f = await fixture(toolStep(mcp));
    expect(f.preview.request_refusals).toEqual([{ step_id: "call", reason }]);
    expect(f.preview.manifest.effects[0]?.effect).toBe("unknown");
    expect(f.preview.eligible_for_repeated_runs).toBe(false);
  }
});

test("the approval is pinned to the tool, its rules, its ceiling and the tool's description", async () => {
  const digests = new Set<string>();
  for (const mcp of [
    {},
    { boundary: boundary({ effect: "write" }) },
    { boundary: boundary({ max_calls: 2 }) },
    { boundary: boundary({ variables: { "input.q": { enum: ["alpha"] } } }) },
    { arguments: { q: "${input.q}", mode: "fuzzy" } },
    {
      boundary: boundary({
        descriptor: { input_schema_digest: "f".repeat(64), annotations: PIN.annotations },
      }),
    },
    { boundary: boundary({ descriptor: { input_schema_digest: PIN.input_schema_digest } }) },
  ]) {
    const f = await fixture(toolStep(mcp, { max_retries: 0 }));
    expect(f.preview.eligible_for_repeated_runs).toBe(true);
    digests.add(JSON.stringify(f.preview.manifest.effects[0]?.mcp));
  }
  expect(digests.size).toBe(7);
});

test("an argument outside its rule is refused before the call, with an audit row", async () => {
  const f = await fixture(toolStep());
  await f.grant();
  const { admitted, result } = await f.run({ q: "gamma" });
  expect(result.status).toBe("failed");
  expect(remote.calls).toEqual([]);
  expect(result.steps.find((step) => step.step_key === "call")?.error).toMatchObject({
    code: "request_outside_declared_boundary",
  });
  const rows = await refusalAudit(admitted.execution_id);
  expect(rows).toEqual([{ result: "denied", reason: "request_outside_declared_boundary" }]);
});

test("a tool the server now describes differently stops the run until a person reviews again", async () => {
  for (const changed of [
    [{ ...SEARCH, annotations: { readOnlyHint: false } }],
    [{ ...SEARCH, inputSchema: { type: "object", properties: { q: {}, purge: {} } } }],
    [{ ...SEARCH, annotations: { readOnlyHint: true, destructiveHint: true } }],
    [{ ...SEARCH, name: "find" }],
    [],
  ]) {
    remote.tools = [SEARCH];
    remote.calls = [];
    __resetMcpClientPoolForTests();
    const f = await fixture(toolStep());
    await f.grant();
    const admitted = await f.admit({ q: "alpha" });
    remote.tools = changed;
    __resetMcpClientPoolForTests();
    const result = await f.runAdmitted(admitted.execution_id, { q: "alpha" });
    expect(result.status).toBe("failed");
    expect(remote.calls).toEqual([]);
    expect(result.steps.find((step) => step.step_key === "call")?.error).toMatchObject({
      code: "execution_authority_changed",
    });
    expect(await refusalAudit(admitted.execution_id)).toEqual([
      { result: "denied", reason: "execution_authority_changed" },
    ]);
  }
});

test("a description that only changes its wording does not stop the run", async () => {
  const f = await fixture(toolStep());
  await f.grant();
  remote.tools = [{ ...SEARCH, description: "search the whole index, faster" }];
  __resetMcpClientPoolForTests();
  const { result } = await f.run({ q: "beta" });
  expect(result.status).toBe("succeeded");
  expect(remote.calls).toHaveLength(1);
});

test("a step that iterates never makes more tool calls than its ceiling", async () => {
  const f = await fixture(
    toolStep(
      {
        arguments: { q: "${item.q}", mode: "exact" },
        boundary: boundary({
          variables: { "item.q": { enum: ["alpha", "beta"] } },
          max_calls: 2,
        }),
      },
      { for_each: "(sourceData) => sourceData.$input.items", for_each_concurrency: 1 },
    ),
  );
  expect(f.preview.eligible_for_repeated_runs).toBe(true);
  await f.grant();
  const within = await f.run({ items: [{ q: "alpha" }, { q: "beta" }] });
  expect(within.result.status).toBe("succeeded");
  expect(remote.calls).toHaveLength(2);
  remote.calls = [];
  const beyond = await f.run({ items: [{ q: "alpha" }, { q: "beta" }, { q: "alpha" }] });
  expect(beyond.result.status).toBe("failed");
  expect(remote.calls.length).toBeLessThanOrEqual(2);
  expect((await refusalAudit(beyond.admitted.execution_id)).length).toBeGreaterThanOrEqual(1);
});

test("dispatch refuses every tool call the approved boundary does not describe", async () => {
  const f = await fixture(toolStep());
  const authority = await f.grant();
  const connector = await getConnectorForEnvironment(
    ctx.tenantId,
    connectorId,
    "dev",
    ctx.testDb.db,
  );
  if (!connector) throw new Error("missing resolved connector");
  const admitted = await f.admit({ q: "alpha" });
  await insertStepRow(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    execution_id: admitted.execution_id,
    step_key: "call",
    step_index: 0,
    kind: "request",
  });
  const base = {
    step_id: "call",
    configuration_digest: authorityConnectorDigest(connector),
    credential_id: null,
    credential_revision: null,
    connection_authority: null,
  };
  const check = (mcp_dispatch: unknown, over: Record<string, unknown> = {}) =>
    assertExecutionAuthorityCurrent(ctx.testDb.db, ctx.tenantId, admitted.execution_id, {
      ...base,
      ...over,
      ...(mcp_dispatch === undefined ? {} : { mcp_dispatch }),
    } as never);
  const call = (over: Record<string, unknown> = {}) => ({
    operation: "call_tool",
    call: { tool: "search", arguments: { q: "alpha", mode: "exact" }, descriptor: PIN, ...over },
  });
  expect(authority.effect_manifest_digest).toBe(f.preview.digest);
  await expect(check(call())).resolves.toBeDefined();
  await expect(check(call({ arguments: { q: "beta", mode: "exact" } }))).resolves.toBeDefined();
  for (const refused of [
    undefined,
    call({ tool: "delete" }),
    call({ arguments: { q: "gamma", mode: "exact" } }),
    call({ arguments: { q: "alpha", mode: "fuzzy" } }),
    call({ arguments: { q: "alpha", mode: "exact", admin: true } }),
    call({ arguments: { q: { $ne: null }, mode: "exact" } }),
    call({ arguments: null }),
    call({ descriptor: null }),
    call({ descriptor: mcpToolDescriptorPin({ ...SEARCH, annotations: {} }) }),
    call({ descriptor: mcpToolDescriptorPin({ ...SEARCH, inputSchema: {} }) }),
    { operation: "call_tool" },
    { operation: "read_resource" },
    { operation: "get_prompt" },
    { operation: "call_tool", call: { tool: "search" } },
    { ...call(), surprise: true },
    "call_tool",
  ])
    await expect(check(refused)).rejects.toMatchObject({ code: "execution_authority_changed" });
  await expect(
    check(call(), { credential_id: actor, credential_revision: 1 }),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
  await expect(check(call(), { configuration_digest: "0".repeat(64) })).rejects.toMatchObject({
    code: "execution_authority_changed",
  });
  await insertStepRow(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    execution_id: admitted.execution_id,
    step_key: "call",
    step_index: 1,
    kind: "request",
  });
  await expect(check(call())).rejects.toMatchObject({ code: "execution_authority_changed" });
});

test("a tool call with no step row behind it is never within the ceiling", async () => {
  const f = await fixture(toolStep());
  await f.grant();
  const connector = await getConnectorForEnvironment(
    ctx.tenantId,
    connectorId,
    "dev",
    ctx.testDb.db,
  );
  if (!connector) throw new Error("missing resolved connector");
  const admitted = await f.admit({ q: "alpha" });
  await expect(
    assertExecutionAuthorityCurrent(ctx.testDb.db, ctx.tenantId, admitted.execution_id, {
      step_id: "call",
      configuration_digest: authorityConnectorDigest(connector),
      credential_id: null,
      credential_revision: null,
      connection_authority: null,
      mcp_dispatch: {
        operation: "call_tool",
        call: { tool: "search", arguments: { q: "alpha", mode: "exact" }, descriptor: PIN },
      },
    } as never),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
});

test("a tool call approved as a write is refused when it could be attempted more than once", async () => {
  const f = await fixture(
    toolStep({ boundary: boundary({ effect: "write" }) }, { max_retries: 0 }),
  );
  await f.grant();
  const connector = await getConnectorForEnvironment(
    ctx.tenantId,
    connectorId,
    "dev",
    ctx.testDb.db,
  );
  if (!connector) throw new Error("missing resolved connector");
  const admitted = await f.admit({ q: "alpha" });
  await insertStepRow(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    execution_id: admitted.execution_id,
    step_key: "call",
    step_index: 0,
    kind: "request",
  });
  const check = (request_max_attempts: number | undefined) =>
    assertExecutionAuthorityCurrent(ctx.testDb.db, ctx.tenantId, admitted.execution_id, {
      step_id: "call",
      configuration_digest: authorityConnectorDigest(connector),
      credential_id: null,
      credential_revision: null,
      connection_authority: null,
      ...(request_max_attempts === undefined ? {} : { request_max_attempts }),
      mcp_dispatch: {
        operation: "call_tool",
        call: { tool: "search", arguments: { q: "alpha", mode: "exact" }, descriptor: PIN },
      },
    } as never);
  await expect(check(1)).resolves.toBeDefined();
  await expect(check(2)).rejects.toMatchObject({ code: "execution_authority_changed" });
  await expect(check(undefined)).rejects.toMatchObject({ code: "execution_authority_changed" });
});
