// The operations the engine performs against a remote MCP server, and how
// each one's result is normalised.
//
// Split out of pool.ts for the same reason manifest.ts was: none of it
// touches a connection. Given a client this module knows which JSON-RPC
// method to issue, which part of the reply is the payload, which server
// capability the call requires, and what to call the target in an audit
// row. The pool keeps what only it can own — which client, whose tenant,
// the timeout, the eviction, the audit write.

import type { McpOperation } from "@shared/index.ts";

/**
 * Every operation the pool can issue.
 *
 * A SUPERSET of `McpOperation`, which is the three a workflow step can
 * address. The three list operations are discovery: they name no target, so
 * a step has nothing to bind them to, and they exist for the chat
 * palette's read-only adapters. Keeping the step's vocabulary at three is
 * what stops a workflow author from writing a step whose result is a page
 * of someone else's catalogue.
 */
export type RemoteOperation =
  | McpOperation
  | "list_resources"
  | "list_resource_templates"
  | "list_prompts";

/** A single operation against a remote, with its target already resolved.
 *  Discriminated on `operation`: `performRemoteCall`'s switch below has no
 *  default arm, so a further member cannot be added without the compiler
 *  demanding the code that issues it. */
export type RemoteCall =
  | { operation: "call_tool"; tool: string; arguments: Record<string, unknown> }
  | { operation: "read_resource"; uri: string }
  | { operation: "get_prompt"; prompt: string; arguments: Record<string, unknown> }
  | { operation: "list_resources"; cursor?: string }
  | { operation: "list_resource_templates"; cursor?: string }
  | { operation: "list_prompts"; cursor?: string };

/** Per-call controls the pool threads down to the SDK.
 *
 *  THE BOUND IS FLAT. The SDK also offers `resetTimeoutOnProgress` (each
 *  progress notification restarts the clock) with `maxTotalTimeout` as the
 *  ceiling. Neither is passed, and the reason is not that a long remote
 *  call is unsupported — it is WHO gets to decide how long one may run.
 *
 *  Progress-extended deadlines hand that decision to the remote: a server
 *  that emits a notification every few seconds holds the turn's toolChain
 *  mutex — and, on the workflow path, the step's slot — for as long as it
 *  keeps talking, while looking healthy the whole time. That is the same
 *  authority `classifyMcpToolSideEffect` refuses on the annotation side: a
 *  third party does not get to set the terms of its own governance.
 *
 *  The lever for a legitimately slow remote therefore lives INSIDE the
 *  tenant, where someone accountable sets it: `connectors.mcp.
 *  remote_tool_call_timeout_ms` raises it for the whole tenant and
 *  `config.mcp.remote_tool_call_timeout_ms` for one connector, both up to
 *  300_000 ms. A call that needs longer than five minutes is a job, not a
 *  tool call.
 *
 *  Progress is reported — it becomes a `tool_log` event so a long call
 *  renders as it runs — and it buys no time. */
export interface RemoteCallOptions {
  timeout_ms: number;
  /** Cancels this ONE in-flight request. The pooled session is shared by
   *  every call in the tenant, so an abort must never be read as the
   *  socket dying — see the pool's cancellation handling. */
  signal?: AbortSignal;
  onProgress?: (p: { progress: number; total?: number; message?: string }) => void;
}

/** The client surface `performRemoteCall` needs. Declared here rather than
 *  in the pool so this module depends on nothing that owns a socket; the
 *  pool's own `McpClientLike` extends it.
 *
 *  The list methods are OPTIONAL because the pool only reaches them
 *  for a server whose negotiated capabilities declared `resources` /
 *  `prompts`, and the in-process fakes that drive the tool path have no
 *  reason to implement what they never declare. */
export interface RemoteCallClient {
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: SdkRequestOptions,
  ): Promise<{
    [key: string]: unknown;
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  }>;
  readResource(
    params: { uri: string },
    resultSchema?: undefined,
    options?: SdkRequestOptions,
  ): Promise<{ [key: string]: unknown; contents?: unknown }>;
  getPrompt(
    params: { name: string; arguments?: Record<string, string> },
    resultSchema?: undefined,
    options?: SdkRequestOptions,
  ): Promise<{ [key: string]: unknown; messages?: unknown }>;
  listResources?(
    params?: { cursor?: string },
    options?: SdkRequestOptions,
  ): Promise<{ [key: string]: unknown; resources?: unknown; nextCursor?: string | undefined }>;
  listResourceTemplates?(
    params?: { cursor?: string },
    options?: SdkRequestOptions,
  ): Promise<{
    [key: string]: unknown;
    resourceTemplates?: unknown;
    nextCursor?: string | undefined;
  }>;
  listPrompts?(
    params?: { cursor?: string },
    options?: SdkRequestOptions,
  ): Promise<{ [key: string]: unknown; prompts?: unknown; nextCursor?: string | undefined }>;
}

/** The slice of the SDK's `RequestOptions` the pool sets. */
export interface SdkRequestOptions {
  timeout?: number;
  signal?: AbortSignal;
  onprogress?: (p: { progress: number; total?: number; message?: string }) => void;
}

export interface RemoteCallOutcome {
  /** VERBATIM payload from the remote. Never truncated here — the caller
   *  persists this and derives the model-facing view separately. */
  content: unknown;
  /**
   * The tool's typed reply, when it sent one, VERBATIM and separate from
   * `content`.
   *
   * Kept apart rather than merged because they are two different claims:
   * `content` is what the tool wants a reader to see, `structuredContent`
   * is what it promises conforms to its declared `outputSchema`. The SDK
   * has already validated the second against that schema by the time it
   * gets here — merging them would lose which half carried the guarantee.
   */
  structured_content?: unknown;
  /** True when the REMOTE answered and reported the call itself failed
   *  (`tools/call` with `isError`). Distinct from a thrown transport
   *  failure: the server is up, so this must not reach the circuit
   *  breaker and must not be retried. */
  remote_error: boolean;
}

/**
 * The MCP method each operation issues. Used in audit metadata and step
 * output so an operator reading a trail sees the protocol call, not just
 * our field name for it.
 */
export const MCP_WIRE_METHOD: Record<RemoteOperation, string> = {
  call_tool: "tools/call",
  read_resource: "resources/read",
  get_prompt: "prompts/get",
  list_resources: "resources/list",
  list_resource_templates: "resources/templates/list",
  list_prompts: "prompts/list",
};

/**
 * The server capability each operation requires the remote to have
 * declared at `initialize`.
 *
 * The pool checks this BEFORE issuing the call. The SDK also asserts it —
 * but it does so by THROWING a plain Error, which the pool would read as
 * the socket dying: it would evict a perfectly healthy session and arm
 * backoff because a workflow step named a resource on a tools-only server.
 * Checking here turns that into what it is, an answer about the call.
 */
export const MCP_REQUIRED_CAPABILITY: Record<RemoteOperation, "tools" | "resources" | "prompts"> = {
  call_tool: "tools",
  read_resource: "resources",
  get_prompt: "prompts",
  list_resources: "resources",
  list_resource_templates: "resources",
  list_prompts: "prompts",
};

/**
 * The audit-facing identity of what was called.
 *
 * A resource URI is the resource's identity, so it is the right label —
 * but its query string is not part of that identity and is a documented
 * place for pre-signed credentials to ride. Strip it; the scheme,
 * authority and path are what an operator reconciles against.
 *
 * A list operation names no target at all, so it labels itself with the
 * wire method: the server is the thing that was asked.
 */
export function remoteCallTarget(call: RemoteCall): string {
  if (call.operation === "call_tool") return call.tool;
  if (call.operation === "get_prompt") return call.prompt;
  if (
    call.operation === "list_resources" ||
    call.operation === "list_resource_templates" ||
    call.operation === "list_prompts"
  ) {
    return MCP_WIRE_METHOD[call.operation];
  }
  const q = call.uri.indexOf("?");
  return q === -1 ? call.uri : call.uri.slice(0, q);
}

/**
 * `prompts/get` takes string arguments only, by specification. An author
 * who writes a number means the number; refusing would be pedantic and
 * silently dropping it would be worse, so non-strings are rendered the
 * way JSON would render them.
 */
function stringifyPromptArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  }
  return out;
}

/**
 * Issue one operation and normalise the reply to
 * `{content, structured_content?, remote_error}`.
 *
 * Throws whatever the client throws — a timeout or a dead socket is the
 * pool's business (evict, count, back off), not this module's.
 */
export async function performRemoteCall(
  client: RemoteCallClient,
  call: RemoteCall,
  opts: RemoteCallOptions,
): Promise<RemoteCallOutcome> {
  const options: SdkRequestOptions = {
    timeout: opts.timeout_ms,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onProgress ? { onprogress: opts.onProgress } : {}),
  };
  switch (call.operation) {
    case "call_tool": {
      const res = await client.callTool(
        { name: call.tool, arguments: call.arguments },
        undefined,
        options,
      );
      return {
        content: res.content,
        // Present-only: an absent key and a key holding `undefined` read
        // the same to a consumer, but only the first survives a JSON
        // round trip through the persisted tool-call row unchanged.
        ...(res.structuredContent !== undefined
          ? { structured_content: res.structuredContent }
          : {}),
        remote_error: Boolean(res.isError),
      };
    }
    case "read_resource": {
      const res = await client.readResource({ uri: call.uri }, undefined, options);
      // `resources/read` has no error flag: the protocol answers with
      // contents or raises a JSON-RPC error, which the SDK throws.
      return { content: res.contents, remote_error: false };
    }
    case "get_prompt": {
      const res = await client.getPrompt(
        { name: call.prompt, arguments: stringifyPromptArgs(call.arguments) },
        undefined,
        options,
      );
      return { content: res.messages, remote_error: false };
    }
    case "list_resources": {
      // Unreachable for a server whose capabilities declared `resources`
      // and whose client is the real SDK Client. A fake that declares the
      // capability without implementing the method is a broken fake, and
      // saying so beats returning an empty list it would read as truth.
      if (!client.listResources) throw new Error("client cannot list resources");
      const res = await client.listResources(
        call.cursor !== undefined ? { cursor: call.cursor } : {},
        options,
      );
      return {
        content: { resources: res.resources ?? [], next_cursor: res.nextCursor ?? null },
        remote_error: false,
      };
    }
    case "list_resource_templates": {
      if (!client.listResourceTemplates) throw new Error("client cannot list resource templates");
      const res = await client.listResourceTemplates(
        call.cursor !== undefined ? { cursor: call.cursor } : {},
        options,
      );
      return {
        content: {
          resource_templates: res.resourceTemplates ?? [],
          next_cursor: res.nextCursor ?? null,
        },
        remote_error: false,
      };
    }
    case "list_prompts": {
      if (!client.listPrompts) throw new Error("client cannot list prompts");
      const res = await client.listPrompts(
        call.cursor !== undefined ? { cursor: call.cursor } : {},
        options,
      );
      return {
        content: { prompts: res.prompts ?? [], next_cursor: res.nextCursor ?? null },
        remote_error: false,
      };
    }
  }
}
