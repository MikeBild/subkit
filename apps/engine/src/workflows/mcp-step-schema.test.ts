// The `mcp` sub-block's authoring contract.
//
// The reason this is a schema concern rather than a runtime one: every
// mistake below is one an author (human or LLM) makes at write time, and
// each has a runtime failure that names the wrong thing. A `read_resource`
// step with `tool` set would fail with "uri is required" against a step
// whose intent was obvious; an mcp step without `connector_id` would reach
// the dispatcher and be told a request step needs a url. Naming the field
// here costs one edit instead of one failed run.
//
// The invariant behind constraint 2 is also asserted: `mcp` is a FIELD of
// `request`, never a member of the step-kind union.

import { describe, expect, test } from "bun:test";
import { RequestStepSchema, StepSchema } from "./types.ts";

const CONNECTOR_ID = "11111111-2222-4333-8444-555555555555";

function parse(mcp: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return RequestStepSchema.safeParse({
    kind: "request",
    id: "s",
    connector_id: CONNECTOR_ID,
    mcp,
    ...extra,
  });
}

function messages(res: ReturnType<typeof parse>): string {
  return res.success
    ? ""
    : res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
}

describe("mcp is a sub-block of request, not a step kind", () => {
  test('there is no { kind: "mcp" } step', () => {
    const res = StepSchema.safeParse({ kind: "mcp", id: "s", tool: "search" });
    expect(res.success).toBe(false);
  });

  test("a request step carrying an mcp block parses as kind request", () => {
    const res = StepSchema.safeParse({
      kind: "request",
      id: "s",
      connector_id: CONNECTOR_ID,
      mcp: { operation: "call_tool", tool: "search" },
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.kind).toBe("request");
  });
});

describe("each operation names its own target field", () => {
  test("call_tool is the default operation and takes `tool`", () => {
    const res = parse({ tool: "search" });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.mcp?.operation).toBe("call_tool");
  });

  test("read_resource takes `uri`, get_prompt takes `prompt`", () => {
    expect(parse({ operation: "read_resource", uri: "file:///a.md" }).success).toBe(true);
    expect(parse({ operation: "get_prompt", prompt: "summarise" }).success).toBe(true);
  });

  test("a missing target names the field the operation needs", () => {
    expect(messages(parse({ operation: "read_resource" }))).toContain(
      'mcp.operation "read_resource" requires mcp.uri',
    );
    expect(messages(parse({ operation: "get_prompt" }))).toContain(
      'mcp.operation "get_prompt" requires mcp.prompt',
    );
    expect(messages(parse({ operation: "call_tool" }))).toContain(
      'mcp.operation "call_tool" requires mcp.tool',
    );
  });

  test("another operation's target field is refused, not ignored", () => {
    // Silently ignoring it is the failure mode: the author believes the
    // uri is what gets read and the engine calls a tool instead.
    const res = parse({ operation: "read_resource", uri: "file:///a.md", tool: "search" });
    expect(res.success).toBe(false);
    expect(messages(res)).toContain('mcp.tool belongs to operation "call_tool"');
  });

  test("read_resource refuses arguments — a resource is named by uri", () => {
    expect(
      messages(parse({ operation: "read_resource", uri: "file:///a", arguments: { a: 1 } })),
    ).toContain("mcp.arguments is not accepted by read_resource");
  });
});

describe("an mcp step is bound to a connector and asserts nothing HTTP-shaped", () => {
  test("a url-only mcp step is refused", () => {
    const res = RequestStepSchema.safeParse({
      kind: "request",
      id: "s",
      url: "https://remote.example.com/mcp",
      mcp: { operation: "call_tool", tool: "search" },
    });
    expect(res.success).toBe(false);
    expect(messages(res)).toContain("mcp step requires connector_id");
  });

  test("expected_statuses and expected_row_count are both refused", () => {
    expect(messages(parse({ tool: "search" }, { expected_statuses: [200] }))).toContain(
      "an MCP call has no HTTP status",
    );
    expect(messages(parse({ tool: "search" }, { expected_row_count: 1 }))).toContain(
      "an MCP call returns content, not rows",
    );
  });

  test("timeout_ms is refused, and the refusal names the lever that works", () => {
    // The dispatcher clears the step timer before the MCP call, so this
    // field bounded nothing. Accepting it would tell the author a deadline
    // is in force when none is.
    const res = parse({ tool: "search" }, { timeout_ms: 5000 });
    expect(res.success).toBe(false);
    const msg = messages(res);
    expect(msg).toContain("timeout_ms does not bound an mcp step");
    expect(msg).toContain("remote_tool_call_timeout_ms");
  });

  test("timeout_ms stays available on a step without an mcp block", () => {
    const res = RequestStepSchema.safeParse({
      kind: "request",
      id: "s",
      connector_id: CONNECTOR_ID,
      timeout_ms: 5000,
    });
    expect(res.success).toBe(true);
  });

  test("the HTTP-verb guard does not fire on an mcp step", () => {
    // The guard's message tells the author to add an s3/sql/mcp block —
    // reaching it from a step that already has one would be nonsense.
    const res = parse({ tool: "search" }, { method: "POST" });
    expect(res.success).toBe(true);
  });
});

describe("the request step's shared affordances stay available", () => {
  test("retry, backoff, error_policy and response_filters all parse alongside mcp", () => {
    const res = parse(
      { operation: "call_tool", tool: "search", arguments: { q: "x" } },
      {
        max_retries: 3,
        retry_backoff_ms: 500,
        error_policy: "all",
        response_filters: [{ target: "KEYS", action: "REMOVE", pattern: "^secret$" }],
        side_effects: "read",
      },
    );
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.max_retries).toBe(3);
      expect(res.data.error_policy).toBe("all");
      expect(res.data.response_filters).toHaveLength(1);
    }
  });
});
