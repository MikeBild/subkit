import { describe, expect, test } from "bun:test";
import {
  type McpBoundaryView,
  mcpBoundaryOf,
  presentMcpBoundary,
} from "@/features/grants/model/authority-mcp";
import { translate } from "@/lib/i18n";

const base: McpBoundaryView = {
  server: "https://tools.example.test/mcp",
  tool: "search",
  effect: "read",
  variables: { "input.q": { enum: ["alpha", "beta"] }, "item.limit": { class: "integer" } },
  arguments: [
    { path: ["options", "limit"], var: "item.limit" },
    { path: ["q"], var: "input.q" },
  ],
  max_calls: 3,
  descriptor: {
    name: "search",
    annotations: { readOnlyHint: true },
    input_schema_digest: "a".repeat(64),
    digest: "0123456789abcdef".repeat(4),
  },
};

describe("presentMcpBoundary", () => {
  test("a call stated as reading on a tool that calls itself read-only is shown as a read", () => {
    const shown = presentMcpBoundary(base, true);
    expect(shown.title).toBe("authority.mcp.read");
    expect(shown.stated).toBe("authority.mcp.statedRead");
    expect(shown.hint).toBe("authority.mcp.hintReadOnly");
    expect(shown.unconfirmedRead).toBe(false);
    expect(shown.cautious).toBe(false);
    expect(shown.target).toBe("https://tools.example.test/mcp · search");
    expect(shown.calls).toBe(3);
    expect(shown.descriptor).toBe("0123456789ab");
    expect(shown.fixed).toBe("authority.mcp.fixedArguments");
    expect(shown.variables).toEqual([
      { key: "authority.boundary.class.integer", values: { name: "options.limit" } },
      { key: "authority.boundary.variable", values: { name: "q", values: "alpha, beta" } },
    ]);
  });

  test("the tool's own hint never turns a stated write into a read", () => {
    const shown = presentMcpBoundary({ ...base, effect: "write" }, true);
    expect(shown.title).toBe("authority.mcp.write");
    expect(shown.stated).toBe("authority.mcp.statedWrite");
    expect(shown.hint).toBe("authority.mcp.hintReadOnly");
    expect(shown.unconfirmedRead).toBe(false);
  });

  test("a stated read on a tool that does not call itself read-only is flagged", () => {
    for (const annotations of [
      {},
      { readOnlyHint: false },
      { destructiveHint: true },
      { readOnlyHint: true, destructiveHint: true },
    ]) {
      const shown = presentMcpBoundary({
        ...base,
        descriptor: { ...base.descriptor, annotations },
      });
      expect(shown.unconfirmedRead).toBe(true);
      expect(shown.cautious).toBe(true);
    }
  });

  test("each kind of self-description has its own sentence", () => {
    const hint = (annotations: McpBoundaryView["descriptor"]["annotations"]) =>
      presentMcpBoundary({ ...base, descriptor: { ...base.descriptor, annotations } }, true).hint;
    expect(hint({})).toBe("authority.mcp.hintNone");
    expect(hint({ readOnlyHint: false })).toBe("authority.mcp.hintChanges");
    expect(hint({ readOnlyHint: true })).toBe("authority.mcp.hintReadOnly");
    expect(hint({ destructiveHint: true })).toBe("authority.mcp.hintDestructive");
    expect(hint({ readOnlyHint: true, destructiveHint: true })).toBe(
      "authority.mcp.hintDestructive",
    );
  });

  test("a call with nothing that varies says so", () => {
    const shown = presentMcpBoundary({ ...base, variables: {}, arguments: [] });
    expect(shown.variables).toEqual([]);
    expect(shown.fixed).toBe("authority.mcp.noVariables");
  });

  test("a caller-bound value and an unknown rule are both named", () => {
    const shown = presentMcpBoundary({
      ...base,
      variables: {
        "caller.subject": { caller_bound: true },
        "input.q": { class: "anything_goes" },
      },
      arguments: [
        { path: ["owner"], var: "caller.subject" },
        { path: ["q"], var: "input.q" },
        { path: ["orphan"], var: "input.missing" },
      ],
    });
    expect(shown.variables).toEqual([
      { key: "authority.boundary.callerBound", values: { name: "owner" } },
      { key: "authority.boundary.unknownRule", values: { name: "q", rule: "anything_goes" } },
      { key: "authority.boundary.unknownRule", values: { name: "orphan", rule: "?" } },
    ]);
    expect(shown.cautious).toBe(true);
  });
});

describe("hints for a viewer the server comparison did not run for", () => {
  test("every hint says the step records it and that nothing was compared", () => {
    const hint = (annotations: McpBoundaryView["descriptor"]["annotations"], compared?: boolean) =>
      presentMcpBoundary({ ...base, descriptor: { ...base.descriptor, annotations } }, compared)
        .hint;
    expect(hint({})).toBe("authority.mcp.recordedNone");
    expect(hint({ readOnlyHint: false })).toBe("authority.mcp.recordedChanges");
    expect(hint({ readOnlyHint: true })).toBe("authority.mcp.recordedReadOnly");
    expect(hint({ destructiveHint: true })).toBe("authority.mcp.recordedDestructive");
    expect(hint({ readOnlyHint: true }, false)).toBe("authority.mcp.recordedReadOnly");
    for (const locale of ["de", "en"] as const)
      for (const key of [
        "authority.mcp.recordedNone",
        "authority.mcp.recordedChanges",
        "authority.mcp.recordedReadOnly",
        "authority.mcp.recordedDestructive",
      ] as const) {
        const text = translate(locale, key);
        expect(text).toMatch(/not compared|nicht mit dem Server verglichen/);
        expect(text).not.toMatch(/The server lists|Der Server führt/);
      }
  });
});

describe("mcpBoundaryOf", () => {
  test("reads the tool boundary of an effect and nothing that only resembles one", () => {
    expect(mcpBoundaryOf({ mcp: base })).toEqual(base);
    expect(mcpBoundaryOf({})).toBeNull();
    expect(mcpBoundaryOf(null)).toBeNull();
    expect(mcpBoundaryOf("mcp")).toBeNull();
    expect(mcpBoundaryOf({ mcp: [] })).toBeNull();
    expect(mcpBoundaryOf({ mcp: { ...base, descriptor: null } })).toBeNull();
    expect(mcpBoundaryOf({ mcp: { ...base, tool: 5 } })).toBeNull();
    expect(mcpBoundaryOf({ mcp: { ...base, server: undefined } })).toBeNull();
    expect(mcpBoundaryOf({ mcp: { ...base, variables: null } })).toBeNull();
    expect(mcpBoundaryOf({ mcp: { ...base, arguments: {} } })).toBeNull();
    expect(mcpBoundaryOf({ mcp: { ...base, max_calls: "3" } })).toBeNull();
    expect(
      mcpBoundaryOf({ mcp: { ...base, descriptor: { ...base.descriptor, digest: 1 } } }),
    ).toBeNull();
  });
});

describe("tool call copy", () => {
  test("every sentence exists in both languages, in plain words", () => {
    const keys = [
      "authority.mcp.read",
      "authority.mcp.write",
      "authority.mcp.statedRead",
      "authority.mcp.statedWrite",
      "authority.mcp.hintReadOnly",
      "authority.mcp.hintDestructive",
      "authority.mcp.hintChanges",
      "authority.mcp.hintNone",
      "authority.mcp.statedReadUnconfirmed",
      "authority.mcp.pinned",
      "authority.mcp.fixedArguments",
      "authority.mcp.noVariables",
      "authority.refusal.mcp_not_a_tool_call",
      "authority.refusal.mcp_no_boundary",
      "authority.refusal.mcp_boundary_invalid",
      "authority.refusal.mcp_tool_not_literal",
      "authority.refusal.mcp_server_unresolved",
      "authority.refusal.mcp_runtime_value_outside_arguments",
      "authority.refusal.mcp_argument_placeholder_unsupported",
      "authority.refusal.mcp_variables_mismatch",
      "authority.refusal.mcp_caller_bound_mismatch",
    ] as const;
    for (const locale of ["de", "en"] as const)
      for (const key of keys) {
        const text = translate(locale, key);
        expect(text).not.toBe(key);
        expect(text).not.toContain("!");
        expect(text).not.toContain("_");
        expect(text).not.toContain("readOnlyHint");
      }
    expect(translate("de", "authority.mcp.descriptor", { digest: "abc" })).toContain("abc");
    expect(translate("en", "authority.mcp.hintReadOnly")).toContain("cannot check");
    expect(translate("de", "authority.mcp.hintReadOnly")).toContain("nicht prüfen");
  });
});
