import type { McpOperation } from "@shared/index.ts";

type RemoteOperation = McpOperation | "list_resources" | "list_resource_templates" | "list_prompts";

export type RemoteCall =
  | { operation: "call_tool"; tool: string; arguments: Record<string, unknown> }
  | { operation: "read_resource"; uri: string }
  | { operation: "get_prompt"; prompt: string; arguments: Record<string, unknown> }
  | { operation: "list_resources"; cursor?: string }
  | { operation: "list_resource_templates"; cursor?: string }
  | { operation: "list_prompts"; cursor?: string };

interface RemoteCallOptions {
  timeout_ms: number;
  signal?: AbortSignal;
  onProgress?: (p: { progress: number; total?: number; message?: string }) => void;
}

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

export interface SdkRequestOptions {
  timeout?: number;
  signal?: AbortSignal;
  onprogress?: (p: { progress: number; total?: number; message?: string }) => void;
}

interface RemoteCallOutcome {
  content: unknown;
  structured_content?: unknown;
  remote_error: boolean;
}

export const MCP_WIRE_METHOD: Record<RemoteOperation, string> = {
  call_tool: "tools/call",
  read_resource: "resources/read",
  get_prompt: "prompts/get",
  list_resources: "resources/list",
  list_resource_templates: "resources/templates/list",
  list_prompts: "prompts/list",
};

export const MCP_REQUIRED_CAPABILITY: Record<RemoteOperation, "tools" | "resources" | "prompts"> = {
  call_tool: "tools",
  read_resource: "resources",
  get_prompt: "prompts",
  list_resources: "resources",
  list_resource_templates: "resources",
  list_prompts: "prompts",
};

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

function stringifyPromptArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  }
  return out;
}

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
        ...(res.structuredContent !== undefined
          ? { structured_content: res.structuredContent }
          : {}),
        remote_error: Boolean(res.isError),
      };
    }
    case "read_resource": {
      const res = await client.readResource({ uri: call.uri }, undefined, options);
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
