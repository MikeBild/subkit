import { describe, expect, test } from "bun:test";
import { EngineError } from "@cli-core/errors.ts";
import { engineCheckDenial } from "../../commands/doctor.ts";

describe("engineCheckDenial", () => {
  test("an engine-operator-only refusal is reported as not checked, never as ok", () => {
    const result = engineCheckDenial(
      "setup",
      new EngineError(403, {
        code: "forbidden",
        message: "operator_only",
        details: { cause: "operator_only" },
      }),
    );
    expect(result?.status).toBe("warn");
    expect(result?.detail).toContain("not checked");
    expect(result?.detail).toContain("engine operator");
    expect(result?.hint).toContain("engine operator");
  });

  test("a role or scope refusal in the operator workspace is also a neutral not-checked warning", () => {
    const result = engineCheckDenial(
      "schema_drift",
      new EngineError(403, {
        code: "forbidden",
        message: "permission_denied",
        details: { cause: "credential_ceiling:scope_not_granted" },
      }),
    );
    expect(result).toEqual({
      name: "schema_drift",
      status: "warn",
      detail: "not checked — this credential cannot read engine checks",
      hint: "ask the engine operator to run `subkit doctor` for this check",
    });
  });

  test("other failures are left to the caller", () => {
    expect(engineCheckDenial("setup", new EngineError(401, { code: "unauthorized" }))).toBeNull();
    expect(engineCheckDenial("setup", new Error("boom"))).toBeNull();
  });
});
