import { describe, expect, test } from "bun:test";
import type { Db } from "../../../db/client.ts";
import type { ConnectorView } from "../../types.ts";
import { invokeMcpConnectorCall, McpToolNameError, mcpEgressInput } from "../mcp.ts";

const db = {} as Db;

function mcpConnector(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: "00000000-0000-4000-8000-0000000000d1",
    tenant_id: "00000000-0000-4000-8000-0000000000d2",
    slug: "docs",
    driver: "mcp",
    environment: "prod",
    auth_type: "none",
    base_url: "https://mcp.example.com/mcp",
    config: { mcp: { transport: "http" } },
    ...overrides,
  } as unknown as ConnectorView;
}

function invoke(
  connector: ConnectorView,
  call: Parameters<typeof invokeMcpConnectorCall>[0]["call"],
) {
  return invokeMcpConnectorCall({
    db,
    tenant_id: connector.tenant_id,
    actor_id: null,
    actor_type: "system",
    connector,
    call,
  }).catch((error: unknown) => error);
}

describe("mcp call validation", () => {
  test("a tool name with the namespace separator is refused before anything is dispatched", async () => {
    const error = await invoke(mcpConnector(), {
      operation: "call_tool",
      tool: "search__all",
      arguments: {},
    });
    expect(error).toBeInstanceOf(McpToolNameError);
    expect((error as McpToolNameError).reason).toBe("invalid_remote_tool");
  });

  test("a connector slug that cannot namespace tools is refused", async () => {
    const error = await invoke(mcpConnector({ slug: "Bad Slug" }), {
      operation: "call_tool",
      tool: "search",
      arguments: {},
    });
    expect((error as McpToolNameError).reason).toBe("invalid_slug");
  });

  test("a composed tool name over 64 characters is refused", async () => {
    const error = await invoke(mcpConnector({ slug: "a".repeat(40) }), {
      operation: "call_tool",
      tool: "b".repeat(20),
      arguments: {},
    });
    expect((error as McpToolNameError).reason).toBe("composed_too_long");
  });

  test("an invalid mcp config is refused with the offending paths", async () => {
    const error = (await invoke(
      mcpConnector({ config: { mcp: { transport: "ws", remote_tool_call_timeout_ms: 10 } } }),
      { operation: "read_resource", uri: "file:///a" },
    )) as Error & { code?: string; details?: string[] };
    expect(error.code).toBe("connector_config_invalid");
    expect(error.message).toBe("invalid mcp connector config for docs");
    expect(error.details?.some((detail) => detail.startsWith("mcp.transport:"))).toBe(true);
    expect(
      error.details?.some((detail) => detail.startsWith("mcp.remote_tool_call_timeout_ms:")),
    ).toBe(true);
  });

  test("a config without the mcp block reports the missing block and the unknown root key", async () => {
    const error = (await invoke(mcpConnector({ config: { other: true } }), {
      operation: "list_prompts",
    })) as Error & { details?: string[] };
    expect(error.details).toEqual([
      "mcp: Invalid input: expected object, received undefined",
      'config: Unrecognized key: "other"',
    ]);
  });

  test("a tool name is validated before the config", async () => {
    const error = await invoke(mcpConnector({ config: { mcp: { transport: "ws" } } }), {
      operation: "call_tool",
      tool: "bad tool",
      arguments: {},
    });
    expect(error).toBeInstanceOf(McpToolNameError);
  });
});

describe("mcp egress input", () => {
  test("maps the call to its wire method and keeps the workflow context", () => {
    expect(
      mcpEgressInput({
        executor: db,
        tenant_id: "t-1",
        actor_id: "u-1",
        actor_type: "user",
        connector: { id: "c-1", slug: "docs", url: "https://mcp.example.com/mcp" },
        call: { operation: "get_prompt", prompt: "p", arguments: {} },
        source: "execution",
        execution_id: "e-1",
        workflow_id: "w-1",
        step_id: "s-1",
      }),
    ).toEqual({
      executor: db,
      tenant_id: "t-1",
      actor_id: "u-1",
      actor_type: "user",
      connector_id: "c-1",
      connector_slug: "docs",
      driver: "mcp",
      credential_id: null,
      operation: "prompts/get",
      url: "https://mcp.example.com/mcp",
      source: "execution",
      execution_id: "e-1",
      workflow_id: "w-1",
      step_id: "s-1",
    });
  });

  test("leaves out workflow context that was not supplied and keeps explicit nulls", () => {
    const input = mcpEgressInput({
      executor: db,
      tenant_id: "t-1",
      actor_id: null,
      actor_type: "system",
      connector: { id: "c-1", slug: "docs", url: null },
      call: { operation: "call_tool", tool: "search", arguments: {} },
      source: "tool",
      execution_id: null,
    });
    expect(input.operation).toBe("tools/call");
    expect(input.url).toBeNull();
    expect("execution_id" in input).toBe(true);
    expect(input.execution_id).toBeNull();
    expect("workflow_id" in input).toBe(false);
    expect("step_id" in input).toBe(false);
  });
});
