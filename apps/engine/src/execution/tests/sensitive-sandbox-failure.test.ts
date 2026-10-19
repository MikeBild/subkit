import { expect, test } from "bun:test";
import { runJs, sandboxFailureCode } from "../../sandboxes/index.ts";
import { SandboxError } from "../../sandboxes/quickjs/types.ts";
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
