// The three MCP operations, and the two places their handling is not
// mechanical.
//
// `remoteCallTarget` is the audit label. A resource URI IS the resource's
// identity, so it is the right label — but a URI's query string is a
// documented place for a pre-signed credential to ride, and an audit row
// is read by more people than the request was. Stripping it is a redaction
// claim, so it gets a test.
//
// `prompts/get` takes string arguments only, by specification. An author
// who writes `{ limit: 7 }` means 7; the failure this guards is the
// alternative of dropping or type-erroring on a value the author supplied.

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
  /** The WHOLE options object, so a test can assert what is absent from
   *  it as well as what is present. */
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
    // No query, nothing to strip — the label is the URI verbatim.
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
    // Unbounded is the failure mode this argument exists for: a hung
    // remote that never returns.
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
    // `resources/read` has no error flag — it answers or the SDK throws.
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
    // The comment on `RemoteCallOptions` says the bound is flat and that
    // progress does not extend it. That is a claim about which SDK request
    // options are set, so it is asserted rather than trusted: the SDK
    // extends a deadline only when `resetTimeoutOnProgress` is passed, and
    // adding it (with or without `maxTotalTimeout`) would let a chatty
    // remote hold the turn's toolChain mutex for as long as it keeps
    // talking. The operator's lever is the configured bound, not the
    // remote's notification rate.
    const { client, seen } = recordingClient();
    const progress: Array<{ progress: number }> = [];
    await performRemoteCall(
      client,
      { operation: "call_tool", tool: "slow", arguments: {} },
      { timeout_ms: 30_000, onProgress: (p) => progress.push(p) },
    );
    const options = seen[0]!.options!;
    // Forwarded under the SDK's own key, so a remote's progress reaches
    // the caller.
    expect(typeof options.onprogress).toBe("function");
    options.onprogress?.({ progress: 1 });
    expect(progress).toEqual([{ progress: 1 }]);
    // And the deadline is exactly the one that was asked for.
    expect(options.timeout).toBe(30_000);
    expect("resetTimeoutOnProgress" in options).toBe(false);
    expect("maxTotalTimeout" in options).toBe(false);
  });

  test("a call with no progress handler passes no progress key at all", async () => {
    // An absent key and a key holding `undefined` are the same to the SDK
    // but not to a reader diffing two request-option objects.
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
    // Eviction, backoff and the circuit breaker all key on this throw
    // reaching the pool. Converting it to a value here would silence them.
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
      list_prompts: "prompts/list",
    });
  });
});
