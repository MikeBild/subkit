import { expect, test } from "bun:test";
import { mcpServerIdentityOf, stdioCommandHash } from "../mcp/client/stdio-identity.ts";
import { workflowJsonDigest } from "./canonical-json.ts";
import {
  assertMcpBoundary,
  compileMcpBoundary,
  describeMcpBoundaryViolation,
  McpBoundarySchema,
  mcpArgumentsViolation,
  mcpBoundary,
  mcpBoundaryTarget,
  mcpBoundaryViolation,
  mcpToolDescriptorPin,
} from "./mcp-boundary.ts";
import { RequestStepSchema } from "./types.ts";

const CONNECTOR = "00000000-0000-4000-8000-000000000001";
const SERVER = "https://mcp.example.test/mcp";
const TOOL = {
  name: "search",
  description: "search the index",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const PIN = mcpToolDescriptorPin(TOOL);

const scope = (over: Record<string, unknown> = {}) => ({
  effect: "read",
  variables: { "input.q": { enum: ["alpha", "beta"] }, "item.limit": { class: "integer" } },
  max_calls: 3,
  descriptor: { input_schema_digest: PIN.input_schema_digest, annotations: PIN.annotations },
  ...over,
});

function step(mcp: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return RequestStepSchema.parse({
    id: "tool",
    kind: "request",
    protocol: "mcp",
    connector_id: CONNECTOR,
    mcp: {
      operation: "call_tool",
      tool: "search",
      arguments: {
        q: "${input.q}",
        options: { limit: "${item.limit}", mode: "exact" },
        tags: ["a", "b"],
      },
      boundary: scope(),
      ...mcp,
    },
    ...extra,
  });
}

function compiled(mcp: Record<string, unknown> = {}) {
  const { boundary, refusal } = compileMcpBoundary(step(mcp), SERVER);
  if (!boundary) throw new Error(`boundary did not compile: ${refusal}`);
  return boundary;
}

const ARGS = { q: "alpha", options: { limit: 5, mode: "exact" }, tags: ["a", "b"] };
const call = (over: Record<string, unknown> = {}) => ({
  tool: "search",
  arguments: ARGS as unknown,
  descriptor: PIN as typeof PIN | null,
  ...over,
});

test("a bounded tool call compiles to the tool, its argument rules, its ceiling and the pinned tool", () => {
  const boundary = compiled();
  expect(boundary).toMatchObject({
    server: SERVER,
    tool: "search",
    effect: "read",
    max_calls: 3,
    arguments: [
      { path: ["options", "limit"], var: "item.limit" },
      { path: ["q"], var: "input.q" },
    ],
    descriptor: PIN,
  });
  expect(mcpBoundaryTarget(boundary)).toBe("https://mcp.example.test/mcp#search");
  expect(McpBoundarySchema.safeParse(boundary).success).toBe(true);
  expect(mcpBoundary(step(), SERVER)).toEqual(boundary);
});

const once = { max_retries: 0 };
const compiledOnce = (mcp: Record<string, unknown>) => {
  const { boundary, refusal } = compileMcpBoundary(step(mcp, once), SERVER);
  if (!boundary) throw new Error(`boundary did not compile: ${refusal}`);
  return boundary;
};

test("a call whose effect nobody stated counts as a write", () => {
  expect(compiledOnce({ boundary: scope({ effect: undefined }) }).effect).toBe("write");
  expect(compiledOnce({ boundary: scope({ effect: "write" }) }).effect).toBe("write");
  expect(compiled({ boundary: scope({ effect: "read" }) }).effect).toBe("read");
});

test("a write may be attempted only once, so a retry can never repeat it", () => {
  const refusal = (mcp: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    compileMcpBoundary(step(mcp, extra), SERVER).refusal;
  for (const boundary of [scope({ effect: "write" }), scope({ effect: undefined })]) {
    expect(refusal({ boundary })).toBe("mcp_write_needs_single_attempt");
    expect(refusal({ boundary }, { max_retries: 1 })).toBe("mcp_write_needs_single_attempt");
    expect(refusal({ boundary }, { max_retries: 0 })).toBeUndefined();
  }
  expect(refusal({ boundary: scope({ effect: "read" }) })).toBeUndefined();
  expect(refusal({ boundary: scope({ effect: "read" }) }, { max_retries: 3 })).toBeUndefined();
});

test("a call without any varying argument compiles with an empty variable set", () => {
  const boundary = compiled({ arguments: { q: "fixed" }, boundary: scope({ variables: {} }) });
  expect(boundary.arguments).toEqual([]);
  expect(compiled({ arguments: undefined, boundary: scope({ variables: {} }) }).arguments).toEqual(
    [],
  );
});

test("every unbounded variant is refused with its cause", () => {
  const refusal = (mcp: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    compileMcpBoundary(step(mcp, extra), SERVER).refusal;
  expect(refusal({ boundary: undefined })).toBe("mcp_no_boundary");
  expect(refusal({ tool: "${input.tool}" })).toBe("mcp_tool_not_literal");
  expect(refusal({ tool: "search__admin" })).toBe("mcp_tool_not_literal");
  expect(refusal({ tool: "search tool" })).toBe("mcp_tool_not_literal");
  expect(
    refusal({ arguments: { q: "prefix-${input.q}", options: { limit: "${item.limit}" } } }),
  ).toBe("mcp_argument_placeholder_unsupported");
  expect(refusal({ arguments: { "${input.q}": "x", l: "${item.limit}" } })).toBe(
    "mcp_argument_placeholder_unsupported",
  );
  expect(refusal({ arguments: { q: "${cred.token}", l: "${item.limit}" } })).toBe(
    "mcp_argument_placeholder_unsupported",
  );
  expect(refusal({ arguments: { q: "${input.q}" } })).toBe("mcp_variables_mismatch");
  expect(refusal({ arguments: { q: "${input.q}", l: "${item.limit}", m: "${input.q}" } })).toBe(
    "mcp_variables_mismatch",
  );
  expect(
    refusal({ arguments: { q: "${input.q}", l: "${item.limit}", extra: "${input.other}" } }),
  ).toBe("mcp_variables_mismatch");
  expect(
    refusal({
      arguments: { q: "${caller.subject}" },
      boundary: scope({ variables: { "caller.subject": { class: "uuid" } } }),
    }),
  ).toBe("mcp_caller_bound_mismatch");
  expect(
    refusal({
      arguments: { q: "${input.q}" },
      boundary: scope({ variables: { "input.q": { class: "path" } } }),
    }),
  ).toBe("mcp_boundary_invalid");
  expect(refusal({}, { headers: { "x-tenant": "${input.tenant}" } })).toBe(
    "mcp_runtime_value_outside_arguments",
  );
  expect(compileMcpBoundary(step(), null).refusal).toBe("mcp_server_unresolved");
  expect(compileMcpBoundary(step(), "ftp://mcp.example.test/mcp").refusal).toBe(
    "mcp_server_unresolved",
  );
  expect(compileMcpBoundary(step(), "https://user:pw@mcp.example.test/mcp").refusal).toBe(
    "mcp_server_unresolved",
  );
  expect(compileMcpBoundary(step(), "not a url").refusal).toBe("mcp_server_unresolved");
});

test("only a tool call can carry a boundary, and the step schema says so", () => {
  const base = { id: "tool", kind: "request", connector_id: CONNECTOR };
  expect(
    RequestStepSchema.safeParse({
      protocol: "mcp",
      ...base,
      mcp: { operation: "read_resource", uri: "file:///a", boundary: scope({ variables: {} }) },
    }).success,
  ).toBe(false);
  expect(
    RequestStepSchema.safeParse({
      protocol: "mcp",
      ...base,
      mcp: { operation: "call_tool", tool: "search", boundary: { ...scope(), max_calls: 0 } },
    }).success,
  ).toBe(false);
  expect(
    RequestStepSchema.safeParse({
      protocol: "mcp",
      ...base,
      mcp: { operation: "call_tool", tool: "search", boundary: { ...scope(), effect: "none" } },
    }).success,
  ).toBe(false);
  expect(
    RequestStepSchema.safeParse({
      protocol: "mcp",
      ...base,
      mcp: { operation: "call_tool", tool: "search", boundary: { ...scope(), surprise: true } },
    }).success,
  ).toBe(false);
  const resource = RequestStepSchema.parse({
    protocol: "mcp",
    ...base,
    mcp: { operation: "read_resource", uri: "file:///a" },
  });
  expect(compileMcpBoundary(resource, SERVER).refusal).toBe("mcp_not_a_tool_call");
  expect(
    compileMcpBoundary(RequestStepSchema.parse({ ...base, method: "GET", path: "/a" }), SERVER)
      .refusal,
  ).toBe("mcp_not_a_tool_call");
});

test("the boundary digest changes with everything a person reviewed", () => {
  const reviewed = workflowJsonDigest(compiled());
  const changed = (mcp: Record<string, unknown>, server = SERVER) =>
    workflowJsonDigest(compileMcpBoundary(step(mcp), server).boundary);
  expect(changed({})).toBe(reviewed);
  expect(workflowJsonDigest(compiledOnce({ boundary: scope({ effect: "write" }) }))).not.toBe(
    reviewed,
  );
  expect(changed({ boundary: scope({ max_calls: 4 }) })).not.toBe(reviewed);
  expect(
    changed({
      boundary: scope({
        variables: {
          "input.q": { enum: ["alpha", "beta", "gamma"] },
          "item.limit": { class: "integer" },
        },
      }),
    }),
  ).not.toBe(reviewed);
  expect(
    changed({
      arguments: {
        q: "${input.q}",
        options: { limit: "${item.limit}", mode: "fuzzy" },
        tags: ["a", "b"],
      },
    }),
  ).not.toBe(reviewed);
  expect(
    changed({
      boundary: scope({
        descriptor: { input_schema_digest: "f".repeat(64), annotations: PIN.annotations },
      }),
    }),
  ).not.toBe(reviewed);
  expect(
    changed({
      boundary: scope({
        descriptor: { input_schema_digest: PIN.input_schema_digest, annotations: {} },
      }),
    }),
  ).not.toBe(reviewed);
  expect(changed({}, "https://other.example.test/mcp")).not.toBe(reviewed);
});

test("the pin follows the tool's name, hints and input schema and nothing else", () => {
  expect(mcpToolDescriptorPin({ ...TOOL, description: "another text" } as typeof TOOL)).toEqual(
    PIN,
  );
  expect(mcpToolDescriptorPin({ ...TOOL, name: "find" }).digest).not.toBe(PIN.digest);
  expect(mcpToolDescriptorPin({ ...TOOL, annotations: { readOnlyHint: false } }).digest).not.toBe(
    PIN.digest,
  );
  expect(mcpToolDescriptorPin({ ...TOOL, annotations: undefined }).digest).not.toBe(PIN.digest);
  expect(
    mcpToolDescriptorPin({ ...TOOL, annotations: { readOnlyHint: true, destructiveHint: true } })
      .digest,
  ).not.toBe(PIN.digest);
  expect(
    mcpToolDescriptorPin({
      ...TOOL,
      inputSchema: { type: "object", properties: { q: { type: "string" }, all: {} } },
    }).digest,
  ).not.toBe(PIN.digest);
  expect(
    mcpToolDescriptorPin({
      ...TOOL,
      annotations: { readOnlyHint: true, title: "Search" } as never,
    }),
  ).toEqual(PIN);
});

test("a conforming call is admitted", () => {
  const boundary = compiled();
  expect(mcpBoundaryViolation(boundary, call())).toBeNull();
  expect(
    mcpBoundaryViolation(
      boundary,
      call({ arguments: { q: "beta", options: { limit: "12", mode: "exact" }, tags: ["a", "b"] } }),
    ),
  ).toBeNull();
  expect(() => assertMcpBoundary(boundary, call())).not.toThrow();
});

test("every kind of violation is refused", () => {
  const boundary = compiled();
  const found = (over: Record<string, unknown>) => mcpBoundaryViolation(boundary, call(over));
  expect(found({ tool: "delete" })).toEqual({ kind: "tool" });
  expect(found({ arguments: { ...ARGS, q: "gamma" } })).toEqual({
    kind: "argument_value",
    path: "q",
    rule: "enum of 2 value(s)",
  });
  expect(found({ arguments: { ...ARGS, options: { limit: -1, mode: "exact" } } })).toEqual({
    kind: "argument_value",
    path: "options.limit",
    rule: "class integer",
  });
  expect(found({ arguments: { ...ARGS, options: { limit: 1.5, mode: "exact" } } })).toMatchObject({
    kind: "argument_value",
  });
  expect(found({ arguments: { ...ARGS, q: { $ne: null } } })).toMatchObject({
    kind: "argument_value",
    path: "q",
  });
  expect(found({ arguments: { ...ARGS, q: ["alpha"] } })).toMatchObject({ kind: "argument_value" });
  expect(found({ arguments: { options: ARGS.options, tags: ARGS.tags } })).toMatchObject({
    kind: "argument_value",
    path: "q",
  });
  expect(found({ arguments: { ...ARGS, options: "exact" } })).toMatchObject({
    kind: "argument_value",
    path: "options.limit",
  });
  expect(found({ arguments: { ...ARGS, options: { limit: 5, mode: "fuzzy" } } })).toEqual({
    kind: "arguments",
  });
  expect(found({ arguments: { ...ARGS, admin: true } })).toEqual({ kind: "arguments" });
  expect(found({ arguments: { ...ARGS, tags: ["a"] } })).toEqual({ kind: "arguments" });
  expect(found({ arguments: { q: "alpha", options: { limit: 5 }, tags: ["a", "b"] } })).toEqual({
    kind: "arguments",
  });
  expect(found({ arguments: [ARGS] })).toEqual({ kind: "arguments" });
  expect(found({ arguments: null })).toEqual({ kind: "arguments" });
  expect(found({ arguments: "q=alpha" })).toEqual({ kind: "arguments" });
  expect(found({ descriptor: null })).toEqual({ kind: "descriptor_missing" });
  expect(
    found({ descriptor: mcpToolDescriptorPin({ ...TOOL, annotations: { readOnlyHint: false } }) }),
  ).toEqual({ kind: "descriptor_changed" });
  expect(
    found({
      descriptor: mcpToolDescriptorPin({ ...TOOL, inputSchema: { type: "object" } }),
    }),
  ).toEqual({ kind: "descriptor_changed" });
  expect(found({ descriptor: mcpToolDescriptorPin({ ...TOOL, name: "find" }) })).toEqual({
    kind: "descriptor_changed",
  });
  expect(
    found({
      descriptor: { ...mcpToolDescriptorPin({ ...TOOL, inputSchema: {} }), digest: PIN.digest },
    }),
  ).toEqual({ kind: "descriptor_changed" });
  expect(found({ descriptor: { ...PIN, extra: true } })).toEqual({ kind: "descriptor_changed" });
  expect(() => assertMcpBoundary(boundary, call({ tool: "delete" }))).toThrow(
    expect.objectContaining({ code: "execution_authority_changed" }),
  );
});

test("an argument inside a list is found by its position", () => {
  const boundary = compiled({
    arguments: { ids: ["fixed", "${input.q}"] },
    boundary: scope({ variables: { "input.q": { enum: ["alpha"] } } }),
  });
  expect(boundary.arguments).toEqual([{ path: ["ids", "1"], var: "input.q" }]);
  const check = (ids: unknown) =>
    mcpArgumentsViolation(boundary, { tool: "search", arguments: { ids } });
  expect(check(["fixed", "alpha"])).toBeNull();
  expect(check(["fixed", "beta"])).toMatchObject({ kind: "argument_value", path: "ids.1" });
  expect(check(["fixed"])).toMatchObject({ kind: "argument_value" });
  expect(check(["other", "alpha"])).toEqual({ kind: "arguments" });
  expect(check(["fixed", "alpha", "more"])).toEqual({ kind: "arguments" });
  expect(check({ "1": "alpha" })).toEqual({ kind: "arguments" });
});

test("a value tied to the caller must look like a caller identity", () => {
  const boundary = compiled({
    arguments: { owner: "${caller.subject}" },
    boundary: scope({ variables: { "caller.subject": { caller_bound: true } } }),
  });
  const check = (owner: unknown) =>
    mcpArgumentsViolation(boundary, { tool: "search", arguments: { owner } });
  expect(check("3f2c1b9a-7d4e-4c1a-9b8e-2a6f0c5d1e77")).toBeNull();
  expect(check("someone-else")).toEqual({
    kind: "argument_value",
    path: "owner",
    rule: "the authenticated caller",
  });
});

test("a stored boundary that no longer holds together is not trusted", () => {
  const boundary = compiled();
  const tampered = (over: Record<string, unknown>) =>
    mcpBoundaryViolation({ ...boundary, ...over } as typeof boundary, call());
  expect(tampered({ tool: "find" })).toEqual({ kind: "boundary_invalid" });
  expect(tampered({ descriptor: { ...boundary.descriptor, digest: "0".repeat(64) } })).toEqual({
    kind: "boundary_invalid",
  });
  expect(tampered({ arguments: [] })).toEqual({ kind: "boundary_invalid" });
  expect(tampered({ variables: {} })).toEqual({ kind: "boundary_invalid" });
  expect(tampered({ effect: "none" })).toEqual({ kind: "boundary_invalid" });
  expect(tampered({ surprise: true })).toEqual({ kind: "boundary_invalid" });
});

test("every refusal has a sentence that does not repeat an argument value", () => {
  const boundary = compiled();
  for (const over of [
    { tool: "delete" },
    { arguments: { ...ARGS, q: "s3cr3t-value" } },
    { arguments: { ...ARGS, admin: "s3cr3t-value" } },
    { descriptor: null },
    { descriptor: mcpToolDescriptorPin({ ...TOOL, name: "find" }) },
  ]) {
    const violation = mcpBoundaryViolation(boundary, call(over));
    expect(violation).not.toBeNull();
    const text = describeMcpBoundaryViolation(violation!);
    expect(text.length).toBeGreaterThan(20);
    expect(text).not.toContain("s3cr3t");
  }
  expect(describeMcpBoundaryViolation({ kind: "boundary_invalid" })).toContain("could not be");
});

test("a stdio connector binds the boundary to its command identity", () => {
  const spec = {
    command: "docker",
    args: ["mcp", "gateway", "run"],
    env: { LOG_LEVEL: "info" },
    env_secret_names: ["GITHUB_TOKEN"],
  };
  const connector = {
    driver: "mcp",
    base_url: null,
    config: { mcp: { transport: "stdio", ...spec } },
  };
  const identity = mcpServerIdentityOf(connector);
  expect(identity).toBe(`stdio:${stdioCommandHash(spec)}`);
  const { boundary, refusal } = compileMcpBoundary(step(), identity);
  expect(refusal).toBeUndefined();
  expect(boundary?.server).toBe(identity as string);
  expect(McpBoundarySchema.safeParse(boundary).success).toBe(true);
  expect(mcpBoundary(step(), boundary?.server)).toEqual(boundary as NonNullable<typeof boundary>);
  const changed = mcpServerIdentityOf({
    ...connector,
    config: { mcp: { transport: "stdio", ...spec, args: ["mcp", "gateway", "run", "--x"] } },
  });
  expect(changed).not.toBe(identity);
  expect(compileMcpBoundary(step(), "stdio:not-a-hash").refusal).toBe("mcp_server_unresolved");
});

test("an http connector keeps its address as the boundary server", () => {
  expect(
    mcpServerIdentityOf({
      driver: "mcp",
      base_url: SERVER,
      config: { mcp: { transport: "http" } },
    }),
  ).toBe(SERVER);
});
