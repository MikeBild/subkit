import { expect, test } from "bun:test";
import { closeDb } from "../db/client.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../mcp/client/pool.ts";
import {
  fixture,
  remote,
  tdb,
  useConversationRunAdmissionSetup,
} from "./conversation-run-admission-fixtures.ts";

useConversationRunAdmissionSetup();

const reads: string[] = [];
const originalDatabaseUrl = process.env.DATABASE_URL;

const fakeClient: McpClientLike = {
  async connect() {},
  async listTools() {
    return { tools: [] };
  },
  async callTool() {
    return { content: [], isError: false };
  },
  async readResource(params) {
    reads.push(params.uri);
    return { contents: [{ uri: params.uri, text: "notes" }] };
  },
  async getPrompt() {
    return { messages: [] };
  },
  async close() {},
};

async function withResourceServer<T>(run: () => Promise<T>): Promise<T> {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  await closeDb();
  process.env.DATABASE_URL = tdb.url;
  try {
    return await run();
  } finally {
    __setMcpPoolFactoriesForTests(null);
    __resetMcpClientPoolForTests();
    await closeDb();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
}

test("a workflow with an MCP resource read still runs under a one-time approval", async () => {
  await withResourceServer(async () => {
    const f = await fixture({ mcpResource: true });
    const before = remote.callCount();
    await f.runTool("synthetic");
    expect(remote.callCount()).toBe(before);
    const readsWhileHeld = reads.length;
    expect(readsWhileHeld).toBeGreaterThanOrEqual(1);
    const result = await f.confirmPrepared();
    expect(result.synthetic_result?.ok).toBe(true);
    expect(remote.callCount()).toBe(before + 1);
    expect(reads.length).toBe(readsWhileHeld + 1);
    expect(new Set(reads)).toEqual(new Set(["file:///notes"]));
  });
});
