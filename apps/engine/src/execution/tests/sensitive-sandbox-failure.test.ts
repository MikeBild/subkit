import { expect, test } from "bun:test";
import { runJs, sandboxFailureCode } from "../../sandboxes/index.ts";
import { SandboxError, SandboxRuntimeError } from "../../sandboxes/quickjs/types.ts";
import { sensitiveFailure } from "../sensitive-payload.ts";

test("sensitive sandbox failures retain only the fixed trusted class", () => {
  for (const kind of [
    "memory",
    "interrupt",
    "timeout",
    "syntax",
    "runtime",
    "marshal",
    "stdlib_init",
  ] as const) {
    const error = new SandboxError("PRIVATE_SANDBOX_CONTENT_CANARY", kind);
    const result = sensitiveFailure(sandboxFailureCode(error) ?? undefined);
    expect(result).toEqual({ code: `sandbox_${kind}`, message: "Sensitive execution failed." });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  }
});

test("arbitrary errors cannot supply a sensitive sandbox class", () => {
  for (const error of [
    new Error("sandbox_runtime PRIVATE_SANDBOX_CONTENT_CANARY"),
    { cause_kind: "runtime", name: "SandboxError" },
  ]) {
    expect(sandboxFailureCode(error)).toBeNull();
    expect(sensitiveFailure("sandbox_unrecognized").code).toBe("sensitive_execution_failure");
  }
});

test("sensitive cursor failures keep fixed repair guidance without response data", () => {
  const incomplete = sensitiveFailure("graphql_pagination_incomplete");
  expect(incomplete.code).toBe("graphql_pagination_incomplete");
  expect(incomplete.message).toContain("pageInfo");
  const mutation = sensitiveFailure("graphql_pagination_not_read_only");
  expect(mutation.code).toBe("graphql_pagination_not_read_only");
  expect(mutation.message).toContain("read-only");
  expect(JSON.stringify([incomplete, mutation])).not.toContain("PRIVATE_CONTENT_CANARY");
});

test("actual isolated runtime and syntax failures expose no source or input", async () => {
  for (const [code, expected] of [
    ["throw new Error(input.value);", "sandbox_runtime"],
    ["return (", "sandbox_syntax"],
  ] as const) {
    let caught: unknown;
    try {
      await runJs({ code, input: { value: "PRIVATE_SANDBOX_CONTENT_CANARY" }, clock: null });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    const result = sensitiveFailure(sandboxFailureCode(caught) ?? undefined);
    expect(result).toEqual({ code: expected, message: "Sensitive execution failed." });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  }
});

test("only exact runtime validation literals become fixed input codes", async () => {
  for (const [literal, code] of [
    ["invalid body", "sandbox_input_body"],
    ["invalid eventType", "sandbox_input_event_type"],
    ["invalid eventId", "sandbox_input_event_id"],
    ["invalid attributes", "sandbox_input_attributes"],
    ["invalid purpose", "sandbox_input_purpose"],
    ["invalid deliveryRequest", "sandbox_input_delivery_request"],
    ["invalid recipient", "sandbox_input_recipient"],
    ["invalid actionUrl", "sandbox_input_action_url"],
  ] as const) {
    let caught: unknown;
    try {
      await runJs({
        code: "throw new Error(input.message);",
        input: { message: literal },
        clock: null,
      });
    } catch (error) {
      caught = error;
    }
    expect(sandboxFailureCode(caught)).toBe(code);
    expect(sensitiveFailure(code)).toEqual({ code, message: "Sensitive execution failed." });
    for (const message of [
      `${literal} PRIVATE_CONTENT_CANARY`,
      `prefix ${literal}`,
      literal.toUpperCase(),
    ]) {
      expect(sandboxFailureCode(new SandboxRuntimeError(message))).toBe("sandbox_runtime");
    }
    expect(sandboxFailureCode(new Error(literal))).toBeNull();
  }
});
