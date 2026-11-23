import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  AUTHORITY_UNREADY_CODES,
  CALLER_BUDGET_CODES,
  CALLER_FORBIDDEN_CODES,
  classifyRunError,
  effectiveHoldWrites,
  enqueueFailureMessage,
  finalizesOnEnqueueFailure,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  precheckRunRequest,
  type RefusalClass,
  type RunDispatchMode,
  rbacDenial,
  refusalCause,
  refusalFromError,
  refusalIsAudited,
  requiresCurrentAuthority,
  resolveExecutionEnvironment,
  returnsReplay,
} from "./run-workflow.ts";

const SEED = { seed: 20261106, numRuns: 200 };

const baseFacts = {
  idempotency_key: null,
  hold_writes: undefined,
  product_bearer: false,
  dispatch: "inline" as RunDispatchMode,
  execution_authority_id: undefined,
};

describe("classifyRunError", () => {
  test("maps every known refusal code to its class", () => {
    expect(classifyRunError({ message: "workflow not found: x" }, "admission")).toBe("not_found");
    expect(classifyRunError({ code: "input_schema_violation" }, "execution")).toBe("input");
    expect(classifyRunError({ code: "rate_limited" }, "admission")).toBe("budget");
    expect(classifyRunError({ code: "caller_required" }, "admission")).toBe("caller_forbidden");
    expect(classifyRunError({ code: "prepared_credential_unavailable" }, "execution")).toBe(
      "authority_unready",
    );
    expect(classifyRunError({ code: "execution_boundary_mismatch" }, "admission")).toBe("boundary");
    expect(classifyRunError({ code: "workflow_version_invalid" }, "admission")).toBe("boundary");
    expect(classifyRunError({ code: "sensitive_execution_unsupported" }, "admission")).toBe(
      "boundary",
    );
    expect(classifyRunError({ code: "workflow_archived" }, "admission")).toBe("boundary");
  });

  test("leaves unexpected errors unclassified", () => {
    expect(classifyRunError({ message: "boom" }, "admission")).toBeNull();
    expect(classifyRunError({ code: 42 }, "admission")).toBeNull();
    expect(classifyRunError({ code: "enqueue_failed" }, "admission")).toBeNull();
  });

  test("budget codes are refusals only at admission", () => {
    expect(classifyRunError({ code: "invalid" }, "admission")).toBe("budget");
    expect(classifyRunError({ code: "invalid" }, "execution")).toBeNull();
  });

  test("property: forbidden and unready codes classify the same at both stages", () => {
    const codes = [...CALLER_FORBIDDEN_CODES, ...AUTHORITY_UNREADY_CODES];
    fc.assert(
      fc.property(
        fc.constantFrom(...codes),
        fc.constantFrom<"admission" | "execution">("admission", "execution"),
        (code, stage) => {
          const refusal = classifyRunError({ code }, stage);
          expect(refusal).toBe(
            CALLER_FORBIDDEN_CODES.has(code) ? "caller_forbidden" : "authority_unready",
          );
        },
      ),
      SEED,
    );
  });

  test("property: any execution_ prefixed code is a refusal", () => {
    fc.assert(
      fc.property(fc.string(), (suffix) => {
        expect(classifyRunError({ code: `execution_${suffix}` }, "execution")).not.toBeNull();
      }),
      SEED,
    );
  });
});

describe("refusalIsAudited", () => {
  test("audits boundary refusals, not caller mistakes", () => {
    const audited: RefusalClass[] = ["budget", "caller_forbidden", "authority_unready", "boundary"];
    const silent: RefusalClass[] = [
      "not_found",
      "input",
      "bad_request",
      "preparation_forbidden",
      "permission_denied",
    ];
    for (const refusal of audited) expect(refusalIsAudited(refusal)).toBe(true);
    for (const refusal of silent) expect(refusalIsAudited(refusal)).toBe(false);
  });
});

describe("refusalFromError", () => {
  test("builds a rejected value with details and execution id", () => {
    const error = Object.assign(new Error("no credential"), {
      code: "prepared_credential_unavailable",
      details: { connector_id: "c1" },
    });
    expect(refusalFromError(error, "execution", "e1")).toEqual({
      kind: "rejected",
      code: "prepared_credential_unavailable",
      message: "no credential",
      refusal: "authority_unready",
      details: { connector_id: "c1" },
      execution_id: "e1",
      cause: error,
    });
  });

  test("names a missing workflow and omits absent fields", () => {
    const error = new Error("workflow not found: abc");
    expect(refusalFromError(error, "admission")).toEqual({
      kind: "rejected",
      code: "workflow_not_found",
      message: "workflow not found: abc",
      refusal: "not_found",
      cause: error,
    });
  });

  test("keeps an empty message when the error has none", () => {
    expect(refusalFromError({ code: "workflow_archived" }, "admission")?.message).toBe("");
  });

  test("returns null for non-objects and unexpected errors", () => {
    expect(refusalFromError("boom", "admission")).toBeNull();
    expect(refusalFromError(null, "admission")).toBeNull();
    expect(refusalFromError(new Error("boom"), "admission")).toBeNull();
  });

  test("property: budget codes become audited rejections at admission", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CALLER_BUDGET_CODES), fc.string(), (code, message) => {
        const refusal = refusalFromError({ code, message }, "admission");
        expect(refusal?.code).toBe(code);
        expect(refusal?.message).toBe(message);
        expect(refusalIsAudited(refusal?.refusal ?? "input")).toBe(true);
      }),
      SEED,
    );
  });
});

describe("precheckRunRequest", () => {
  test("accepts a plain request", () => {
    expect(precheckRunRequest(baseFacts)).toBeNull();
  });

  test("rejects an empty or oversized idempotency key", () => {
    expect(precheckRunRequest({ ...baseFacts, idempotency_key: "" })).toMatchObject({
      code: "bad_request",
      refusal: "bad_request",
      message: "idempotency_key must be 1..200 characters",
    });
    expect(
      precheckRunRequest({
        ...baseFacts,
        idempotency_key: "k".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1),
      }),
    ).toMatchObject({ code: "bad_request" });
    expect(
      precheckRunRequest({ ...baseFacts, idempotency_key: "k".repeat(IDEMPOTENCY_KEY_MAX_LENGTH) }),
    ).toBeNull();
  });

  test("a product caller cannot ask for a held preparation", () => {
    expect(
      precheckRunRequest({ ...baseFacts, product_bearer: true, hold_writes: true }),
    ).toMatchObject({ code: "product_preparation_forbidden", refusal: "preparation_forbidden" });
    expect(
      precheckRunRequest({ ...baseFacts, product_bearer: true, hold_writes: false }),
    ).toBeNull();
    expect(
      precheckRunRequest({ ...baseFacts, product_bearer: false, hold_writes: true }),
    ).toBeNull();
  });

  test("an authorized queued run needs an idempotency key", () => {
    expect(
      precheckRunRequest({ ...baseFacts, dispatch: "enqueue", execution_authority_id: "a1" }),
    ).toMatchObject({
      code: "bad_request",
      message:
        "An authorized async run requires an idempotency_key so queue retries reuse its reservation",
    });
    expect(
      precheckRunRequest({
        ...baseFacts,
        dispatch: "enqueue",
        execution_authority_id: "a1",
        idempotency_key: "k",
      }),
    ).toBeNull();
    expect(
      precheckRunRequest({ ...baseFacts, dispatch: "inline", execution_authority_id: "a1" }),
    ).toBeNull();
    expect(precheckRunRequest({ ...baseFacts, dispatch: "enqueue" })).toBeNull();
  });

  test("property: keys within bounds never fail the length rule", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: IDEMPOTENCY_KEY_MAX_LENGTH }), (key) => {
        expect(precheckRunRequest({ ...baseFacts, idempotency_key: key })).toBeNull();
      }),
      SEED,
    );
  });
});

describe("hold writes and dispatch rules", () => {
  test("a product caller never downgrades to a preparation", () => {
    expect(effectiveHoldWrites(true, undefined)).toBe(false);
    expect(effectiveHoldWrites(false, undefined)).toBeUndefined();
    expect(effectiveHoldWrites(false, true)).toBe(true);
  });

  test("replays return unless a queued run should be dispatched", () => {
    const admitted = { execution_authority_id: null, status: "succeeded", replayed: true };
    expect(returnsReplay(admitted, "dispatch")).toBe(true);
    expect(returnsReplay({ ...admitted, status: "queued" }, "dispatch")).toBe(false);
    expect(returnsReplay({ ...admitted, status: "queued" }, "return")).toBe(true);
    expect(returnsReplay({ ...admitted, replayed: false }, "return")).toBe(false);
  });

  test("property: a fresh admission never returns as a replay", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom<"dispatch" | "return">("dispatch", "return"),
        (s, q) => {
          expect(
            returnsReplay({ execution_authority_id: null, status: s, replayed: false }, q),
          ).toBe(false);
        },
      ),
      SEED,
    );
  });

  test("only a queued authorized run checks its authority before enqueue", () => {
    const queued = { execution_authority_id: "a1", status: "queued", replayed: false };
    expect(requiresCurrentAuthority("enqueue", queued)).toBe(true);
    expect(requiresCurrentAuthority("inline", queued)).toBe(false);
    expect(requiresCurrentAuthority("enqueue", { ...queued, status: "running" })).toBe(false);
    expect(requiresCurrentAuthority("enqueue", { ...queued, execution_authority_id: null })).toBe(
      false,
    );
  });

  test("enqueue failures finalize only runs without an idempotency key", () => {
    expect(finalizesOnEnqueueFailure(null)).toBe(true);
    expect(finalizesOnEnqueueFailure("k")).toBe(false);
    expect(enqueueFailureMessage(undefined)).toBe("The execution could not be enqueued.");
    expect(enqueueFailureMessage("p1")).toBe("The rerun could not be enqueued.");
  });
});

describe("resolveExecutionEnvironment", () => {
  test("a product principal runs in its configured environment", () => {
    expect(
      resolveExecutionEnvironment({
        product_id: "p",
        product_environment: "prod",
        requested: "dev",
      }),
    ).toBe("prod");
    expect(
      resolveExecutionEnvironment({
        product_id: "p",
        product_environment: null,
        requested: "prod",
      }),
    ).toBe("dev");
  });

  test("other principals choose the requested environment", () => {
    expect(
      resolveExecutionEnvironment({
        product_id: null,
        product_environment: null,
        requested: "prod",
      }),
    ).toBe("prod");
    expect(
      resolveExecutionEnvironment({
        product_id: null,
        product_environment: "prod",
        requested: null,
      }),
    ).toBe("dev");
  });

  test("property: the request never overrides a product environment", () => {
    const env = fc.constantFrom<"dev" | "prod">("dev", "prod");
    fc.assert(
      fc.property(env, env, (product_environment, requested) => {
        expect(
          resolveExecutionEnvironment({ product_id: "p", product_environment, requested }),
        ).toBe(product_environment);
      }),
      SEED,
    );
  });
});

describe("rbacDenial", () => {
  test("allowlist principals learn only that the workflow is not allowlisted", () => {
    expect(rbacDenial({ provider: "portal_token", allowlisted: false, reason: "x" })).toEqual({
      reason: "workflow_not_in_allowlist",
      message: "workflow_not_in_allowlist",
    });
    expect(rbacDenial({ provider: "api_key", allowlisted: true, reason: undefined })).toEqual({
      reason: "workflow_not_in_allowlist",
      message: "workflow_not_in_allowlist",
    });
  });

  test("other principals get the evaluator reason or a default", () => {
    expect(rbacDenial({ provider: "api_key", allowlisted: false, reason: "no role" })).toEqual({
      reason: "no role",
      message: "no role",
    });
    expect(rbacDenial({ provider: undefined, allowlisted: false, reason: undefined })).toEqual({
      reason: "workflow_run_permission_denied",
      message: "permission_denied",
    });
  });
});

describe("refusalCause", () => {
  test("returns the original error or builds one carrying the code", () => {
    const original = new Error("archived");
    expect(
      refusalCause({
        kind: "rejected",
        code: "workflow_archived",
        message: "archived",
        refusal: "boundary",
        cause: original,
      }),
    ).toBe(original);
    const built = refusalCause({
      kind: "rejected",
      code: "bad_request",
      message: "bad key",
      refusal: "bad_request",
    }) as Error & { code: string };
    expect(built.message).toBe("bad key");
    expect(built.code).toBe("bad_request");
  });
});

describe("refusal vocabularies", () => {
  test("list every refusal code a caller can meet", () => {
    expect([...CALLER_FORBIDDEN_CODES]).toEqual([
      "caller_required",
      "caller_kind_mismatch",
      "caller_product_mismatch",
      "caller_tenant_mismatch",
      "caller_saved_workflow_required",
      "sensitive_resume_forbidden",
    ]);
    expect([...AUTHORITY_UNREADY_CODES]).toEqual([
      "execution_authority_required",
      "execution_authority_expired",
      "execution_authority_exhausted",
      "execution_authority_revoked",
      "execution_authority_changed",
      "workflow_version_not_active",
      "prepared_credential_unavailable",
    ]);
    expect([...CALLER_BUDGET_CODES]).toEqual([
      "rate_limited",
      "turn_busy",
      "turn_limit",
      "invalid",
    ]);
  });

  test("a function carrying a code is not an error value", () => {
    expect(
      refusalFromError(
        Object.assign(() => {}, { code: "workflow_archived" }),
        "admission",
      ),
    ).toBeNull();
  });

  test("a refusal without details carries no details key", () => {
    const refusal = refusalFromError({ code: "workflow_archived", message: "x" }, "admission");
    expect(refusal && "details" in refusal).toBe(false);
  });

  test("prechecks answer complete rejected values", () => {
    expect(precheckRunRequest({ ...baseFacts, product_bearer: true, hold_writes: true })).toEqual({
      kind: "rejected",
      code: "product_preparation_forbidden",
      message:
        "A product caller runs only under a live execution authority; held preparations are for operators.",
      refusal: "preparation_forbidden",
    });
    expect(
      precheckRunRequest({ ...baseFacts, dispatch: "enqueue", execution_authority_id: "a1" }),
    ).toEqual({
      kind: "rejected",
      code: "bad_request",
      message:
        "An authorized async run requires an idempotency_key so queue retries reuse its reservation",
      refusal: "bad_request",
    });
  });
});
