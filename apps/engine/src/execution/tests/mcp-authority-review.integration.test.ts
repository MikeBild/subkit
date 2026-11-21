import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { previewWorkflowAuthorityOperation } from "../../api/operations/workflow-authorities.ts";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { assertReviewedToolPinsCurrent } from "../../conversations/workflow-review-tool-pins.ts";
import { closeDb } from "../../db/client.ts";
import {
  conversations,
  sessions,
  users,
  workflowExecutionAuthorities,
  workflowReviewReceipts,
} from "../../db/schema/index.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import {
  grantWorkflowAuthority,
  previewWorkflowAuthority,
} from "../../workflows/execution-authorities.ts";
import { mcpToolDescriptorPin } from "../../workflows/mcp-boundary.ts";
import {
  assertPreviewedToolPinsCurrent,
  assertToolPinsCurrent,
} from "../../workflows/tool-pin-review.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let connectorId: string;
let sequence = 0;
const originalDatabaseUrl = testEnv.DATABASE_URL;

const SEARCH = {
  name: "search",
  description: "search the index",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const PIN = mcpToolDescriptorPin(SEARCH);
const PROD_SEARCH = {
  ...SEARCH,
  inputSchema: { type: "object", properties: { q: { type: "string" }, region: {} } },
};
const PROD_PIN = mcpToolDescriptorPin(PROD_SEARCH);
const PROD_URL = "https://tools-prod.mcpreview.example.com/mcp";
const remote = {
  connects: 0,
  lists: 0,
  tools: [SEARCH] as Array<Record<string, unknown>>,
};

const clientFor = (url: string): McpClientLike => ({
  ...fakeClient,
  async listTools() {
    remote.lists++;
    return { tools: url === PROD_URL ? [PROD_SEARCH] : remote.tools };
  },
});

const fakeClient: McpClientLike = {
  async connect() {
    remote.connects++;
  },
  async listTools() {
    remote.lists++;
    return { tools: remote.tools };
  },
  async callTool() {
    return { content: [], isError: false };
  },
  async readResource(params) {
    return { contents: [{ uri: params.uri, text: "" }] };
  },
  async getPrompt() {
    return { messages: [] };
  },
  async close() {},
};

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: (row) => clientFor(row.url) });
  ctx = await createEngineCtx("mcp-authority-review");
  await closeDb();
  testEnv.DATABASE_URL = ctx.testDb.url;
  const server = await seedMcpConnector(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    slug: "mcpreview",
    display_name: "MCP Review",
    environment: "dev",
    transport: "http",
    url: "https://tools.mcpreview.example.com/mcp",
  });
  connectorId = server.id;
  await seedMcpConnector(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    slug: "mcpreview",
    display_name: "MCP Review",
    environment: "prod",
    transport: "http",
    url: PROD_URL,
  });
}, 30_000);

beforeEach(() => {
  remote.tools = [SEARCH];
  __resetMcpClientPoolForTests();
  remote.connects = 0;
  remote.lists = 0;
});

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (originalDatabaseUrl === undefined) delete testEnv.DATABASE_URL;
  else testEnv.DATABASE_URL = originalDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

async function fixture(
  descriptor: Record<string, unknown> = {
    input_schema_digest: PIN.input_schema_digest,
    annotations: PIN.annotations,
  },
  tool = "search",
) {
  const slug = `mcp-authority-review-${++sequence}`;
  const workflow = await createWorkflowRow(ctx, {
    name: slug,
    slug,
    steps: [
      {
        id: "call",
        kind: "request",
        connector_id: connectorId,
        mcp: {
          operation: "call_tool",
          tool,
          arguments: { q: "${input.q}" },
          boundary: {
            effect: "read",
            variables: { "input.q": { enum: ["alpha"] } },
            max_calls: 1,
            descriptor,
          },
        },
      },
    ],
  });
  const reference = {
    tenant_id: ctx.tenantId,
    workflow_id: workflow.workflow_id,
    workflow_version_id: workflow.version_id,
    execution_environment: "dev" as const,
  };
  return { reference, preview: await previewWorkflowAuthority(reference, ctx.testDb.db) };
}

const WRONG_PIN = { input_schema_digest: "f".repeat(64), annotations: PIN.annotations };

async function human(role: "admin" | "enduser") {
  const db = ctx.testDb.db;
  const now = await databaseNow(db);
  const [user] = await db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: `${role}-${++sequence}@example.test`,
      role_id: await builtinRoleId(db, role),
      status: "active",
    })
    .returning();
  if (!user) throw new Error("missing user");
  const [session] = await db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: user.id,
      expires_at: new Date(now.getTime() + 3_600_000),
    })
    .returning();
  if (!session) throw new Error("missing session");
  const identity = { tenant_id: ctx.tenantId, user_id: user.id, session_id: session.id };
  const principal: ResolvedPrincipal = {
    provider: "session",
    kind: "user",
    id: user.id,
    tenant_id: ctx.tenantId,
    roles: [role],
    session_id: session.id,
  };
  const request = new Request("https://example.test/grant", {
    method: "POST",
    headers: {
      cookie: browserSessionCookie(await signBrowserSession(identity)),
      "x-subkit-csrf": await signBrowserCsrf(identity),
    },
  });
  return { principal, request, now };
}

test("the review compares the pinned description with the server only when asked to", async () => {
  const review = (f: Awaited<ReturnType<typeof fixture>>, compare_tool_pins: boolean) =>
    previewWorkflowAuthority(f.reference, ctx.testDb.db, {
      include_review: true,
      compare_tool_pins,
    });
  const matching = await fixture();
  expect(remote.connects).toBe(0);
  const uncompared = await review(matching, false);
  expect(remote.connects).toBe(0);
  expect(uncompared.tool_pins_compared).toBe(false);
  expect(uncompared.eligible_for_repeated_runs).toBe(true);
  const agreed = await review(matching, true);
  expect(remote.connects).toBe(1);
  expect(agreed.tool_pins_compared).toBe(true);
  expect(agreed.request_refusals).toEqual([]);
  expect(agreed.eligible_for_repeated_runs).toBe(true);
  expect(agreed.digest).toBe(matching.preview.digest);

  const wrongPin = await fixture(WRONG_PIN);
  expect(wrongPin.preview.eligible_for_repeated_runs).toBe(true);
  expect((await review(wrongPin, false)).request_refusals).toEqual([]);
  const mismatch = await review(wrongPin, true);
  expect(mismatch.request_refusals).toEqual([{ step_id: "call", reason: "mcp_tool_changed" }]);
  expect(mismatch.eligible_for_repeated_runs).toBe(false);
  expect(mismatch.digest).toBe(wrongPin.preview.digest);

  const missing = await review(await fixture(undefined, "lookup"), true);
  expect(missing.request_refusals).toEqual([{ step_id: "call", reason: "mcp_tool_unavailable" }]);
  expect(missing.eligible_for_repeated_runs).toBe(false);
  expect(remote.connects).toBe(1);
});

test("a preview outside the review never contacts the server", async () => {
  const f = await fixture();
  const plain = await previewWorkflowAuthority(f.reference, ctx.testDb.db);
  expect(plain.tool_pins_compared).toBe(false);
  expect(remote.connects).toBe(0);
});

test("the dialog preview compares the pin only for someone who may grant the approval", async () => {
  const f = await fixture(WRONG_PIN);
  const preview = async (role: "admin" | "enduser", browser = true) => {
    const { principal, request } = await human(role);
    return (await previewWorkflowAuthorityOperation.handler(
      {
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        principal,
        actor: { id: principal.id, type: principal.kind },
        ...(browser ? { request } : {}),
      },
      {
        id: f.reference.workflow_id,
        version_id: f.reference.workflow_version_id,
        environment: "dev",
      },
    )) as {
      tool_pins_compared?: boolean;
      request_refusals?: Array<{ step_id: string; reason: string }>;
      eligible_for_repeated_runs?: boolean;
    };
  };
  const reader = await preview("enduser");
  expect(remote.connects).toBe(0);
  expect(reader.tool_pins_compared).toBe(false);
  expect(reader.request_refusals).toEqual([]);
  const withoutBrowser = await preview("admin", false);
  expect(remote.connects).toBe(0);
  expect(withoutBrowser.tool_pins_compared).toBe(false);
  expect(withoutBrowser.request_refusals).toEqual([]);
  const granter = await preview("admin");
  expect(remote.connects).toBe(1);
  expect(granter.tool_pins_compared).toBe(true);
  expect(granter.request_refusals).toEqual([{ step_id: "call", reason: "mcp_tool_changed" }]);
  expect(granter.eligible_for_repeated_runs).toBe(false);
});

test("no approval is written on a pin that does not match the server", async () => {
  const authoritiesOf = (workflow_id: string) =>
    ctx.testDb.db
      .select({ id: workflowExecutionAuthorities.id })
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, ctx.tenantId),
          eq(workflowExecutionAuthorities.workflow_id, workflow_id),
        ),
      );
  const { principal, request, now } = await human("admin");
  const grant = (f: Awaited<ReturnType<typeof fixture>>) =>
    grantWorkflowAuthority(
      f.reference.workflow_id,
      {
        workflow_version_id: f.reference.workflow_version_id,
        expected_manifest_digest: f.preview.digest,
        execution_environment: "dev",
        valid_from: now.toISOString(),
        valid_until: new Date(now.getTime() + 3_600_000).toISOString(),
        max_runs: 2,
      },
      { db: ctx.testDb.db, request, principal },
    );
  const wrongPin = await fixture(WRONG_PIN);
  await expect(grant(wrongPin)).rejects.toMatchObject({ code: "mcp_tool_changed" });
  expect(await authoritiesOf(wrongPin.reference.workflow_id)).toEqual([]);

  const missing = await fixture(undefined, "lookup");
  await expect(grant(missing)).rejects.toMatchObject({ code: "mcp_tool_unavailable" });
  expect(await authoritiesOf(missing.reference.workflow_id)).toEqual([]);

  const matching = await fixture();
  const connectsBefore = remote.connects;
  remote.tools = [{ ...SEARCH, annotations: { readOnlyHint: false } }];
  await expect(grant(matching)).rejects.toMatchObject({ code: "mcp_tool_changed" });
  expect(await authoritiesOf(matching.reference.workflow_id)).toEqual([]);

  remote.tools = [SEARCH];
  const listsBefore = remote.lists;
  await expect(grant(matching)).resolves.toMatchObject({ id: expect.any(String) });
  expect(await authoritiesOf(matching.reference.workflow_id)).toHaveLength(1);
  expect(remote.lists).toBe(listsBefore + 1);
  expect(remote.connects).toBe(connectsBefore);
});

test("the pin check names the step and leaves a stale review to the digest check", async () => {
  const wrongPin = await fixture(WRONG_PIN);
  await expect(
    assertToolPinsCurrent(ctx.testDb.db, ctx.tenantId, wrongPin.preview.manifest.effects),
  ).rejects.toMatchObject({ code: "mcp_tool_changed", details: { step_id: "call" } });
  const matching = await fixture();
  await expect(
    assertToolPinsCurrent(ctx.testDb.db, ctx.tenantId, matching.preview.manifest.effects),
  ).resolves.toBeUndefined();
  __resetMcpClientPoolForTests();
  remote.connects = 0;
  await expect(
    assertPreviewedToolPinsCurrent(
      ctx.testDb.db,
      ctx.tenantId,
      "0".repeat(64),
      async () => wrongPin.preview,
    ),
  ).resolves.toBeUndefined();
  expect(remote.connects).toBe(0);
});

test("the chat review compares the pin before it writes an approval, and only for its own granter", async () => {
  const db = ctx.testDb.db;
  const definition = (descriptor: Record<string, unknown>) => ({
    name: "Chat reviewed tool call",
    steps: [
      {
        id: "call",
        kind: "request",
        connector_id: connectorId,
        mcp: {
          operation: "call_tool",
          tool: "search",
          arguments: { q: "${input.q}" },
          boundary: {
            effect: "read",
            variables: { "input.q": { enum: ["alpha"] } },
            max_calls: 1,
            descriptor,
          },
        },
      },
    ],
  });
  const { principal, now } = await human("admin");
  const session_id = principal.session_id as string;
  const [conversation] = await db
    .insert(conversations)
    .values({ tenant_id: ctx.tenantId, status: "active" })
    .returning();
  if (!conversation) throw new Error("missing conversation");
  const receipt = async (descriptor: Record<string, unknown>, grant: boolean) => {
    const [row] = await db
      .insert(workflowReviewReceipts)
      .values({
        tenant_id: ctx.tenantId,
        conversation_id: conversation.id,
        prepared_by: principal.id,
        session_id,
        snapshot: {
          saved_definition: definition(descriptor),
          actions: { activate: grant, grant: grant ? { environment: "dev" } : null },
        },
        snapshot_digest: "a".repeat(64),
        expires_at: new Date(now.getTime() + 3_600_000),
      })
      .returning();
    if (!row) throw new Error("missing receipt");
    return row.id;
  };
  const check = (receipt_id: string, by: ResolvedPrincipal = principal, session = session_id) =>
    assertReviewedToolPinsCurrent(db, {
      tenant_id: ctx.tenantId,
      conversation_id: conversation.id,
      receipt_id,
      principal: by,
      session_id: session,
    });
  const matching = { input_schema_digest: PIN.input_schema_digest, annotations: PIN.annotations };

  await expect(check(await receipt(WRONG_PIN, true))).rejects.toMatchObject({
    code: "mcp_tool_changed",
  });
  await expect(check(await receipt(matching, true))).resolves.toBeUndefined();

  __resetMcpClientPoolForTests();
  remote.connects = 0;
  await expect(check(await receipt(WRONG_PIN, false))).resolves.toBeUndefined();
  const other = await human("admin");
  await expect(check(await receipt(WRONG_PIN, true), other.principal)).resolves.toBeUndefined();
  await expect(
    check(await receipt(WRONG_PIN, true), principal, other.principal.session_id as string),
  ).resolves.toBeUndefined();
  await expect(check("00000000-0000-4000-8000-00000000dead")).resolves.toBeUndefined();
  expect(remote.connects).toBe(0);
});

test("a grant issued from inside another transaction never contacts the server", async () => {
  const { principal, request, now } = await human("admin");
  const f = await fixture();
  const grant = (tool_pins: "compared" | "refuse") =>
    grantWorkflowAuthority(
      f.reference.workflow_id,
      {
        workflow_version_id: f.reference.workflow_version_id,
        expected_manifest_digest: f.preview.digest,
        execution_environment: "dev",
        valid_from: now.toISOString(),
        valid_until: new Date(now.getTime() + 3_600_000).toISOString(),
        max_runs: 2,
      },
      { db: ctx.testDb.db, request, principal },
      { tool_pins },
    );
  await expect(grant("refuse")).rejects.toMatchObject({ code: "mcp_tool_unavailable" });
  expect(remote.connects).toBe(0);
  await expect(grant("compared")).resolves.toMatchObject({ id: expect.any(String) });
  expect(remote.connects).toBe(0);
});

test("the pin is compared with the server of the environment the approval is for", async () => {
  const pinned = async (pin: typeof PIN) => {
    const slug = `mcp-authority-review-${++sequence}`;
    const workflow = await createWorkflowRow(ctx, {
      name: slug,
      slug,
      steps: [
        {
          id: "call",
          kind: "request",
          connector_id: connectorId,
          mcp: {
            operation: "call_tool",
            tool: "search",
            arguments: { q: "${input.q}" },
            boundary: {
              effect: "read",
              variables: { "input.q": { enum: ["alpha"] } },
              max_calls: 1,
              descriptor: {
                input_schema_digest: pin.input_schema_digest,
                annotations: pin.annotations,
              },
            },
          },
        },
      ],
    });
    return (environment: "dev" | "prod") =>
      previewWorkflowAuthority(
        {
          tenant_id: ctx.tenantId,
          workflow_id: workflow.workflow_id,
          workflow_version_id: workflow.version_id,
          execution_environment: environment,
        },
        ctx.testDb.db,
      );
  };
  const check = async (preview: Awaited<ReturnType<Awaited<ReturnType<typeof pinned>>>>) =>
    assertToolPinsCurrent(ctx.testDb.db, ctx.tenantId, preview.manifest.effects);
  const prodPinned = await pinned(PROD_PIN);
  const devPinned = await pinned(PIN);
  expect((await prodPinned("prod")).manifest.effects[0]?.environment).toBe("prod");
  await expect(check(await prodPinned("prod"))).resolves.toBeUndefined();
  await expect(check(await devPinned("dev"))).resolves.toBeUndefined();
  await expect(check(await devPinned("prod"))).rejects.toMatchObject({
    code: "mcp_tool_changed",
  });
  await expect(check(await prodPinned("dev"))).rejects.toMatchObject({
    code: "mcp_tool_changed",
  });
});
