// Authoring over MCP is opt-in per credential — and the refusal is real.
//
// The catalogue has always omitted `conversation_*` for a credential without
// authoring. Omission alone is not a boundary: the `conversation_*` dispatch
// branch ran before any mode check, so a client that knew the name could open
// an authoring session with a credential that was never granted one. The mode
// was a display preference on the one branch where it mattered most.
//
// These tests exercise the CALL, not the listing. A test that only asserted
// absence from `tools/list` would have passed against the hole.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { MCP_AUTHORING_SCOPE } from "../../auth/scopes.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("authoring-opt-in");
}, 90_000);

afterAll(async () => {
  await suite?.cleanup();
}, 30_000);

/** Connect with a credential carrying exactly these scopes. */
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
    // The regression this pins: knowing the name was enough.
    const client = await connectWithScopes(["workflow:read"]);
    const result = (await client.callTool({
      name: "conversation_start",
      arguments: { message: "build me a workflow" },
    })) as { isError?: boolean; content?: { type: string; text?: string }[] };

    expect(result.isError).toBe(true);
    const text = (result.content ?? []).map((c) => c.text ?? "").join(" ");
    // The refusal has to be actionable in both directions: where authoring
    // does work, and what would make it work here.
    expect(text).toContain("sk");
    expect(text).toContain(MCP_AUTHORING_SCOPE);
    await client.close();
  }, 60_000);

  test("cannot call conversation_append either", async () => {
    // The gate covers the prefix, not one named tool — otherwise a client
    // could skip `start` and drive an existing conversation directly.
    const client = await connectWithScopes(["workflow:read"]);
    const result = (await client.callTool({
      name: "conversation_append",
      arguments: { conversation_id: "00000000-0000-0000-0000-000000000000", message: "x" },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    await client.close();
  }, 60_000);

  test("still reaches the tools it is meant to reach", async () => {
    // The gate must not become a blanket denial: reading and running are
    // exactly what a non-authoring credential is for.
    const client = await connectWithScopes(["workflow:read"]);
    const names = await listedToolNames(client);
    expect(names.has("run_workflow")).toBe(true);
    expect(names.has("find_workflow")).toBe(true);
    await client.close();
  }, 60_000);
});

describe("the connect instructions match what the credential can do", () => {
  // The server's `initialize` instructions are the first thing a model reads,
  // and it acts on them. Telling a read-and-execute credential to "start with
  // conversation_start" sends it at a tool it will be refused — the model then
  // spends the turn recovering from the server's own advice.
  test("a read-and-execute credential is pointed at the CLI, not at conversation_start", async () => {
    const client = await connectWithScopes(["workflow:read"]);
    const instructions = client.getInstructions() ?? "";

    expect(instructions).not.toContain("Start with `conversation_start`");
    expect(instructions).toContain("sk workflows --help");
    // And it is still told what it CAN do first.
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

    // Whatever the turn does next, it must not be the mode refusal — that
    // would mean the opt-in never opens.
    const text = (result.content ?? []).map((c) => c.text ?? "").join(" ");
    expect(text).not.toContain("Authoring is not enabled for this credential");
    await client.close();
  }, 90_000);
});
