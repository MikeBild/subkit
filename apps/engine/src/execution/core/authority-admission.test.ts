import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  credentialWithinBoundary,
  findAuthorizedEffect,
  governingExecutionCanDispatch,
  mcpDispatchWithinBoundary,
  referenceWithinBoundary,
  toolCallsWithinCeiling,
} from "./authority-admission.ts";

const snapshot = {
  step_id: "read",
  configuration_digest: "configuration",
  credential_id: "credential",
  credential_revision: 3,
  connection_authority: { id: "connection", revision: 5 },
};
const binding = {
  digest: "binding",
  primary: { id: "credential", revision: 3 },
  connection: { id: "connection", revision: 5 },
};

test("authorized effects match step, digest and entire ordered call path", () => {
  const effect = Object.freeze({
    step_id: "read",
    configuration_digest: "configuration",
    call_path: Object.freeze(["parent", "child"]),
  });
  expect(findAuthorizedEffect([effect], snapshot, ["parent", "child"])).toBe(effect);
  expect(
    findAuthorizedEffect([effect], { ...snapshot, step_id: "other" }, ["parent", "child"]),
  ).toBeUndefined();
  expect(
    findAuthorizedEffect([effect], { ...snapshot, configuration_digest: "changed" }, [
      "parent",
      "child",
    ]),
  ).toBeUndefined();
  expect(findAuthorizedEffect([effect], snapshot, ["child", "parent"])).toBeUndefined();
  expect(findAuthorizedEffect([effect], snapshot, ["parent"])).toBeUndefined();
  expect(
    findAuthorizedEffect(
      [{ step_id: "read", configuration_digest: "configuration" }],
      snapshot,
      [],
    ),
  ).toEqual({ step_id: "read", configuration_digest: "configuration" });
});

test("referenced authorities require the same connector and configuration, with credential constraints when present", () => {
  const reference = {
    connector_id: "connector",
    configuration_digest: "configuration",
    credential_id: "credential",
    credential_revision: 3,
  };
  expect(referenceWithinBoundary(reference, "connector", snapshot)).toBe(true);
  expect(referenceWithinBoundary(reference, null, snapshot)).toBe(false);
  expect(referenceWithinBoundary(reference, "other", snapshot)).toBe(false);
  expect(
    referenceWithinBoundary(
      { ...reference, configuration_digest: "changed" },
      "connector",
      snapshot,
    ),
  ).toBe(false);
  expect(
    referenceWithinBoundary({ ...reference, credential_id: "other" }, "connector", snapshot),
  ).toBe(false);
  expect(
    referenceWithinBoundary({ ...reference, credential_revision: 4 }, "connector", snapshot),
  ).toBe(false);
  expect(
    referenceWithinBoundary({ ...reference, credential_id: null }, "connector", snapshot),
  ).toBe(true);
});

test("credential bindings require available metadata and exact primary/connection revisions", () => {
  expect(credentialWithinBoundary(snapshot, "binding", binding)).toBe(true);
  expect(credentialWithinBoundary(snapshot, "binding", null)).toBe(false);
  expect(credentialWithinBoundary(snapshot, "other", binding)).toBe(false);
  expect(credentialWithinBoundary(snapshot, "binding", { ...binding, primary: null })).toBe(false);
  expect(
    credentialWithinBoundary(snapshot, "binding", {
      ...binding,
      primary: { id: "other", revision: 3 },
    }),
  ).toBe(false);
  expect(
    credentialWithinBoundary(snapshot, "binding", {
      ...binding,
      primary: { id: "credential", revision: 4 },
    }),
  ).toBe(false);
  expect(
    credentialWithinBoundary(snapshot, "binding", {
      ...binding,
      connection: { id: "connection", revision: 6 },
    }),
  ).toBe(false);
  expect(credentialWithinBoundary(snapshot, "binding", { ...binding, connection: null })).toBe(
    false,
  );
  expect(
    credentialWithinBoundary({ ...snapshot, connection_authority: null }, "binding", {
      ...binding,
      connection: null,
    }),
  ).toBe(true);
});

test("only active uncancelled governing runs can dispatch", () => {
  for (const status of ["queued", "running"]) {
    expect(governingExecutionCanDispatch(status, false)).toBe(true);
    expect(governingExecutionCanDispatch(status, true)).toBe(false);
  }
  for (const status of ["succeeded", "failed", "aborted", "timed_out", "unknown"])
    expect(governingExecutionCanDispatch(status, false)).toBe(false);
});

test("different credential revisions cannot inherit a prior boundary", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1000 }).filter((revision) => revision !== 3),
      (revision) => {
        const facts = Object.freeze({
          ...binding,
          primary: Object.freeze({ id: "credential", revision }),
        });
        const before = JSON.stringify(facts);
        expect(credentialWithinBoundary(snapshot, "binding", facts)).toBe(false);
        expect(JSON.stringify(facts)).toBe(before);
      },
    ),
    { seed: 20261109, numRuns: 100 },
  );
});

test("a dispatch that is not an MCP call passes only against an effect that is not one", () => {
  expect(mcpDispatchWithinBoundary("http", false, null)).toBe("not_mcp");
  expect(mcpDispatchWithinBoundary("s3", false, null)).toBe("not_mcp");
  expect(mcpDispatchWithinBoundary("http", true, null)).toBe("refused");
  expect(mcpDispatchWithinBoundary("http", false, { operation: "call_tool", has_call: true })).toBe(
    "refused",
  );
  expect(mcpDispatchWithinBoundary("http", false, "malformed")).toBe("refused");
});

test("an MCP effect needs a well-formed MCP dispatch", () => {
  expect(mcpDispatchWithinBoundary("mcp", true, null)).toBe("refused");
  expect(mcpDispatchWithinBoundary("mcp", false, null)).toBe("refused");
  expect(mcpDispatchWithinBoundary("mcp", true, "malformed")).toBe("refused");
  expect(mcpDispatchWithinBoundary("mcp", false, "malformed")).toBe("refused");
});

test("a tool call is admitted only with a reviewed tool boundary and the call itself", () => {
  const call = { operation: "call_tool", has_call: true };
  expect(mcpDispatchWithinBoundary("mcp", true, call)).toBe("tool_call");
  expect(mcpDispatchWithinBoundary("mcp", false, call)).toBe("refused");
  expect(mcpDispatchWithinBoundary("mcp", true, { operation: "call_tool", has_call: false })).toBe(
    "refused",
  );
  expect(mcpDispatchWithinBoundary("mcp", false, { operation: "call_tool", has_call: false })).toBe(
    "refused",
  );
});

test("another MCP operation never passes as the reviewed tool call", () => {
  for (const operation of ["read_resource", "get_prompt"]) {
    expect(mcpDispatchWithinBoundary("mcp", false, { operation, has_call: false })).toBe(
      "other_operation",
    );
    expect(mcpDispatchWithinBoundary("mcp", true, { operation, has_call: false })).toBe("refused");
    expect(mcpDispatchWithinBoundary("mcp", false, { operation, has_call: true })).toBe("refused");
    expect(mcpDispatchWithinBoundary("mcp", true, { operation, has_call: true })).toBe("refused");
  }
});

test("started tool calls are counted per iteration when the step iterates", () => {
  expect(toolCallsWithinCeiling({ exact: 1, iterations: 0 }, 1)).toBe(true);
  expect(toolCallsWithinCeiling({ exact: 2, iterations: 0 }, 1)).toBe(false);
  expect(toolCallsWithinCeiling({ exact: 2, iterations: 0 }, 2)).toBe(true);
  expect(toolCallsWithinCeiling({ exact: 1, iterations: 3 }, 3)).toBe(true);
  expect(toolCallsWithinCeiling({ exact: 1, iterations: 4 }, 3)).toBe(false);
  expect(toolCallsWithinCeiling({ exact: 5, iterations: 1 }, 1)).toBe(true);
  expect(toolCallsWithinCeiling({ exact: 0, iterations: 1 }, 1)).toBe(true);
});

test("a dispatch with no started step row is never within the ceiling", () => {
  expect(toolCallsWithinCeiling({ exact: 0, iterations: 0 }, 1)).toBe(false);
  expect(toolCallsWithinCeiling({ exact: 0, iterations: 0 }, 10_000)).toBe(false);
});

test("the ceiling is inclusive for any count", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 10_000 }),
      fc.integer({ min: 1, max: 10_000 }),
      (calls, max) => {
        expect(toolCallsWithinCeiling({ exact: calls, iterations: 0 }, max)).toBe(calls <= max);
        expect(toolCallsWithinCeiling({ exact: 1, iterations: calls }, max)).toBe(calls <= max);
      },
    ),
    { seed: 20261109, numRuns: 200 },
  );
});
