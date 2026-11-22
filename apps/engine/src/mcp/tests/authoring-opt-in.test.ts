import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCP_AUTHORING_SCOPE } from "../../auth/scopes.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("authoring-opt-in");
}, 90_000);

afterAll(async () => {
  await suite?.cleanup();
}, 30_000);

async function connectWithScopes(scopes: string[]): Promise<Client> {
  const { plaintext } = await suite.issueApiKey(scopes);
  return suite.connectWithApiKey(plaintext);
}

async function listedToolNames(client: Client): Promise<Set<string>> {
  const listed = await client.listTools();
  return new Set(listed.tools.map((t) => t.name));
}

describe("a credential without authoring", () => {
  test("does not see conversation_start", async () => {
    const client = await connectWithScopes(["workflow:read"]);
    expect((await listedToolNames(client)).has("conversation_start")).toBe(false);
    await client.close();
  }, 60_000);

  test("cannot call conversation_start either — the omission is enforced", async () => {
    const client = await connectWithScopes(["workflow:read"]);
    const result = (await client.callTool({
      name: "conversation_start",
      arguments: { message: "build me a workflow" },
    })) as { isError?: boolean; content?: { type: string; text?: string }[] };

    expect(result.isError).toBe(true);
    const text = (result.content ?? []).map((c) => c.text ?? "").join(" ");
    expect(text).toContain("subkit");
    expect(text).toContain(MCP_AUTHORING_SCOPE);
    await client.close();
  }, 60_000);

  test("cannot call conversation_append either", async () => {
    const client = await connectWithScopes(["workflow:read"]);
    const result = (await client.callTool({
      name: "conversation_append",
      arguments: { conversation_id: "00000000-0000-0000-0000-000000000000", message: "x" },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    await client.close();
  }, 60_000);

  test("still reaches the tools it is meant to reach", async () => {
    const client = await connectWithScopes(["workflow:read"]);
    const names = await listedToolNames(client);
    expect(names.has("run_workflow")).toBe(true);
    expect(names.has("find_workflow")).toBe(true);
    await client.close();
  }, 60_000);
});

describe("the connect instructions match what the credential can do", () => {
  test("a read-and-execute credential is pointed at the CLI, not at conversation_start", async () => {
    const client = await connectWithScopes(["workflow:read"]);
    const instructions = client.getInstructions() ?? "";

    expect(instructions).not.toContain("Start with `conversation_start`");
    expect(instructions).toContain("subkit workflows --help");
    expect(instructions).toContain("find_workflow");
    await client.close();
  }, 60_000);

  test("an authoring credential still gets the authoring opening", async () => {
    const client = await connectWithScopes([MCP_AUTHORING_SCOPE]);
    expect(client.getInstructions() ?? "").toContain("Start with `conversation_start`");
    await client.close();
  }, 60_000);
});

describe("a credential carrying mcp:authoring", () => {
  test("sees and may call the conversation cluster", async () => {
    const client = await connectWithScopes([MCP_AUTHORING_SCOPE]);
    expect((await listedToolNames(client)).has("conversation_start")).toBe(true);

    const result = (await client.callTool({
      name: "conversation_start",
      arguments: { message: "hello" },
    })) as { isError?: boolean; content?: { type: string; text?: string }[] };

    const text = (result.content ?? []).map((c) => c.text ?? "").join(" ");
    expect(text).not.toContain("Authoring is not enabled for this credential");
    await client.close();
  }, 90_000);
});
