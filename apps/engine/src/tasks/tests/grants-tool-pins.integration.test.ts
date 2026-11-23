import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { closeDb, type Db } from "../../db/client.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { mcpToolDescriptorPin } from "../../workflows/mcp-boundary.ts";
import { grantTaskAuthority } from "../grants.ts";
import { taskGrantFixtures } from "./grants-fixtures.ts";

let ctx: TestDb;
const originalDatabaseUrl = testEnv.DATABASE_URL;

const f = taskGrantFixtures({
  get ctx() {
    return ctx;
  },
});

const SEARCH = {
  name: "search",
  description: "search the index",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const PIN = mcpToolDescriptorPin(SEARCH);
const remote = {
  lists: 0,
  lists_in_transaction: 0,
  open_transactions: 0,
  tools: [SEARCH] as Array<Record<string, unknown>>,
};

const fakeClient: McpClientLike = {
  async connect() {
    if (remote.open_transactions > 0) remote.lists_in_transaction++;
  },
  async listTools() {
    remote.lists++;
    if (remote.open_transactions > 0) remote.lists_in_transaction++;
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

function watched(db: Db): Db {
  return new Proxy(db, {
    get(target, key) {
      if (key === "transaction")
        return async (...args: Parameters<Db["transaction"]>) => {
          remote.open_transactions++;
          try {
            return await target.transaction(...args);
          } finally {
            remote.open_transactions--;
          }
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  ctx = await createTestDb("task_grant_tool_pins");
  await closeDb();
  testEnv.DATABASE_URL = ctx.url;
}, 30_000);

beforeEach(() => {
  remote.tools = [SEARCH];
  __resetMcpClientPoolForTests();
  remote.lists = 0;
  remote.lists_in_transaction = 0;
});

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (originalDatabaseUrl === undefined) delete testEnv.DATABASE_URL;
  else testEnv.DATABASE_URL = originalDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

async function scenario() {
  const tenant = await f.tenant();
  const admin = await f.person(tenant.id, "admin");
  const server = await seedMcpConnector(ctx.db, {
    tenant_id: tenant.id,
    slug: "pinned-tools",
    display_name: "Pinned tools",
    environment: "dev",
    transport: "http",
    url: `https://tools-${tenant.slug}.example.com/mcp`,
  });
  const pinned = await f.workflow(tenant.id, {
    step: {
      id: "call",
      kind: "request",
      protocol: "mcp",
      connector_id: server.id,
      mcp: {
        operation: "call_tool",
        tool: "search",
        arguments: { q: "${input.q}" },
        boundary: {
          effect: "read",
          variables: { "input.q": { enum: ["alpha"] } },
          max_calls: 1,
          descriptor: {
            input_schema_digest: PIN.input_schema_digest,
            annotations: PIN.annotations,
          },
        },
      },
    },
  });
  const plain = await f.workflow(tenant.id);
  const task = await f.task(tenant.id, admin.user.id, [pinned.id, plain.id]);
  const input = await f.reviewed(task.id, admin);
  const context = { ...admin.context, db: watched(admin.context.db) };
  return { tenant, admin, pinned, plain, task, input, context };
}

test("a pin that matches the server is compared before the transaction and the workflow is granted", async () => {
  const s = await scenario();
  expect(Object.keys(s.input.expected_workflow_digests).sort()).toEqual(
    [s.pinned.id, s.plain.id].sort(),
  );
  expect(remote.lists).toBe(0);
  const result = await grantTaskAuthority(s.task.id, s.input, s.context);
  const byId = new Map(result.workflows.map((workflow) => [workflow.workflow_id, workflow]));
  expect(byId.get(s.pinned.id)).toMatchObject({ outcome: "granted", reason: null });
  expect(byId.get(s.plain.id)).toMatchObject({ outcome: "granted", reason: null });
  expect(remote.lists).toBeGreaterThan(0);
  expect(remote.lists_in_transaction).toBe(0);
  expect(await f.authorities(s.tenant.id)).toHaveLength(2);
});

test("a tool the server now describes differently leaves its workflow without an approval", async () => {
  const s = await scenario();
  remote.tools = [
    { ...SEARCH, inputSchema: { type: "object", properties: { q: {}, region: {} } } },
  ];
  const result = await grantTaskAuthority(s.task.id, s.input, s.context);
  const byId = new Map(result.workflows.map((workflow) => [workflow.workflow_id, workflow]));
  expect(byId.get(s.pinned.id)).toEqual({
    workflow_id: s.pinned.id,
    outcome: "not_granted",
    authority_id: null,
    reason: "workflow_not_repeatable",
  });
  expect(byId.get(s.plain.id)).toMatchObject({ outcome: "granted" });
  expect(remote.lists_in_transaction).toBe(0);
  const authorities = await f.authorities(s.tenant.id);
  expect(authorities.map((authority) => authority.workflow_id)).toEqual([s.plain.id]);
});

test("a tool that is gone from the server leaves its workflow without an approval", async () => {
  const s = await scenario();
  remote.tools = [];
  const result = await grantTaskAuthority(s.task.id, s.input, s.context);
  expect(result.workflows.find((workflow) => workflow.workflow_id === s.pinned.id)).toMatchObject({
    outcome: "not_granted",
    reason: "workflow_not_repeatable",
  });
  expect(remote.lists_in_transaction).toBe(0);
});

test("a stale task fingerprint is refused without asking the server", async () => {
  const s = await scenario();
  const refused = await grantTaskAuthority(
    s.task.id,
    { ...s.input, expected_fingerprint: "c".repeat(64) },
    s.context,
  ).catch((error: { code?: string }) => error.code);
  expect(refused).toBe("task_fingerprint_changed");
  expect(remote.lists).toBe(0);
});
