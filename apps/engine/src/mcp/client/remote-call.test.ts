import { describe, expect, test } from "bun:test";
import {
  MCP_WIRE_METHOD,
  performRemoteCall,
  type RemoteCall,
  type RemoteCallClient,
  remoteCallTarget,
  type SdkRequestOptions,
} from "./remote-call.ts";

interface SeenCall {
  method: string;
  params: unknown;
  timeout: number | undefined;
  options: SdkRequestOptions | undefined;
}

function recordingClient(): {
  client: RemoteCallClient;
  seen: SeenCall[];
  isError: boolean;
} {
  const state = { isError: false };
  const seen: SeenCall[] = [];
  const client: RemoteCallClient = {
    async callTool(params, _s, options) {
      seen.push({ method: "callTool", params, timeout: options?.timeout, options });
      return { content: [{ type: "text", text: "tool" }], isError: state.isError };
    },
    async readResource(params, _s, options) {
      seen.push({ method: "readResource", params, timeout: options?.timeout, options });
      return { contents: [{ uri: params.uri, text: "res" }] };
    },
    async getPrompt(params, _s, options) {
      seen.push({ method: "getPrompt", params, timeout: options?.timeout, options });
      return { messages: [{ role: "user" }] };
    },
  };
  return { client, seen, isError: state.isError };
}

describe("remoteCallTarget", () => {
  test("a tool call is labelled by its tool name, a prompt by its prompt name", () => {
    expect(remoteCallTarget({ operation: "call_tool", tool: "search", arguments: {} })).toBe(
      "search",
    );
    expect(remoteCallTarget({ operation: "get_prompt", prompt: "summarise", arguments: {} })).toBe(
      "summarise",
    );
  });

  test("a resource URI keeps its identity and loses its query string", () => {
    expect(
      remoteCallTarget({
        operation: "read_resource",
        uri: "https://files.example.com/reports/q3.md?X-Amz-Signature=deadbeefdeadbeef",
      }),
    ).toBe("https://files.example.com/reports/q3.md");
    expect(remoteCallTarget({ operation: "read_resource", uri: "file:///reports/q3.md" })).toBe(
      "file:///reports/q3.md",
    );
  });
});

describe("performRemoteCall", () => {
  test("each operation issues its own method and carries the bound", async () => {
    const { client, seen } = recordingClient();
    const calls: RemoteCall[] = [
      { operation: "call_tool", tool: "search", arguments: { q: "x" } },
      { operation: "read_resource", uri: "file:///a.md" },
      { operation: "get_prompt", prompt: "summarise", arguments: {} },
    ];
    for (const call of calls) await performRemoteCall(client, call, { timeout_ms: 1234 });
    expect(seen.map((s) => s.method)).toEqual(["callTool", "readResource", "getPrompt"]);
    expect(seen.every((s) => s.timeout === 1234)).toBe(true);
  });

  test("only tools/call can report a remote error", async () => {
    const { client } = recordingClient();
    const read = await performRemoteCall(
      client,
      { operation: "read_resource", uri: "f:///a" },
      {
        timeout_ms: 10,
      },
    );
    expect(read.remote_error).toBe(false);
    expect(read.content).toEqual([{ uri: "f:///a", text: "res" }]);
  });

  test("prompt arguments are rendered to strings rather than dropped", async () => {
    const { client, seen } = recordingClient();
    await performRemoteCall(
      client,
      {
        operation: "get_prompt",
        prompt: "summarise",
        arguments: { tone: "terse", limit: 7, deep: { a: 1 } },
      },
      { timeout_ms: 10 },
    );
    expect((seen[0]!.params as { arguments: Record<string, string> }).arguments).toEqual({
      tone: "terse",
      limit: "7",
      deep: '{"a":1}',
    });
  });

  test("a progress handler is forwarded and buys the remote no extra time", async () => {
    const { client, seen } = recordingClient();
    const progress: Array<{ progress: number }> = [];
    await performRemoteCall(
      client,
      { operation: "call_tool", tool: "slow", arguments: {} },
      { timeout_ms: 30_000, onProgress: (p) => progress.push(p) },
    );
    const options = seen[0]!.options!;
    expect(typeof options.onprogress).toBe("function");
    options.onprogress?.({ progress: 1 });
    expect(progress).toEqual([{ progress: 1 }]);
    expect(options.timeout).toBe(30_000);
    expect("resetTimeoutOnProgress" in options).toBe(false);
    expect("maxTotalTimeout" in options).toBe(false);
  });

  test("a call with no progress handler passes no progress key at all", async () => {
    const { client, seen } = recordingClient();
    await performRemoteCall(
      client,
      { operation: "read_resource", uri: "f:///a" },
      {
        timeout_ms: 5_000,
      },
    );
    expect("onprogress" in seen[0]!.options!).toBe(false);
    expect("signal" in seen[0]!.options!).toBe(false);
  });

  test("a thrown transport failure is not swallowed here", async () => {
    const client: RemoteCallClient = {
      async callTool() {
        throw new Error("socket hang up");
      },
      async readResource() {
        return { contents: [] };
      },
      async getPrompt() {
        return { messages: [] };
      },
    };
    await expect(
      performRemoteCall(
        client,
        { operation: "call_tool", tool: "t", arguments: {} },
        {
          timeout_ms: 10,
        },
      ),
    ).rejects.toThrow("socket hang up");
  });
});

describe("MCP_WIRE_METHOD", () => {
  test("names the protocol methods, not our field names", () => {
    expect(MCP_WIRE_METHOD).toEqual({
      call_tool: "tools/call",
      read_resource: "resources/read",
      get_prompt: "prompts/get",
      list_resources: "resources/list",
      list_resource_templates: "resources/templates/list",
      list_prompts: "prompts/list",
    });
  });
});

describe("list_resource_templates", () => {
  test("issues resources/templates/list and hands back the templates and the cursor", async () => {
    const seen: Array<{ cursor?: string } | undefined> = [];
    const client: RemoteCallClient = {
      async callTool() {
        throw new Error("a template listing must never reach tools/call");
      },
      async readResource() {
        throw new Error("a template listing must never reach resources/read");
      },
      async getPrompt() {
        return { messages: [] };
      },
      async listResourceTemplates(params) {
        seen.push(params);
        return {
          resourceTemplates: [{ uriTemplate: "reports://database/{id}/tables", name: "tables" }],
          nextCursor: "page2",
        };
      },
    };
    const out = await performRemoteCall(
      client,
      { operation: "list_resource_templates" },
      { timeout_ms: 1_000 },
    );
    expect(seen).toEqual([{}]);
    expect(out).toEqual({
      content: {
        resource_templates: [{ uriTemplate: "reports://database/{id}/tables", name: "tables" }],
        next_cursor: "page2",
      },
      remote_error: false,
    });
    expect(remoteCallTarget({ operation: "list_resource_templates" })).toBe(
      "resources/templates/list",
    );
  });
});
