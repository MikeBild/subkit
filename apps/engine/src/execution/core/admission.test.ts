import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  type AdmissionFacts,
  type AdmissionRequest,
  bindingOf,
  boundaryOfExecution,
  DOWNGRADABLE_AUTHORITY_CODES,
  decideAdmission,
  type ExecutionBoundary,
  sameExecutionBoundary,
} from "./admission.ts";

const FC = { seed: 20261106, numRuns: 200 } as const;

const WF = "11111111-1111-4111-8111-111111111111";
const V1 = "22222222-2222-4222-8222-222222222222";
const V2 = "33333333-3333-4333-8333-333333333333";
const AUTH = "44444444-4444-4444-8444-444444444444";

const base: AdmissionRequest = { workflow_id: WF };

const boundary: ExecutionBoundary = {
  binding: "held",
  execution_authority_id: null,
  workflow_id: WF,
  workflow_version_id: V1,
  execution_mode: "dev",
  parent_execution_id: null,
  caller_context: { tenantId: "t", kind: "user" },
  caller_origin: "principal",
  input: { a: [1, 2] },
};

const idArb = fc.constantFrom(WF, V1, V2, AUTH);
const optId = fc.option(idArb, { nil: undefined });
const nullableId = fc.option(idArb, { nil: null });
const jsonArb = fc.jsonValue({ maxDepth: 2 });

const boundaryArb: fc.Arbitrary<ExecutionBoundary> = fc.record({
  binding: fc.constantFrom("held", "authorized", "unbound"),
  execution_authority_id: nullableId,
  workflow_id: idArb,
  workflow_version_id: nullableId,
  execution_mode: fc.constantFrom("dev", "prod"),
  parent_execution_id: nullableId,
  caller_context: fc.option(jsonArb, { nil: null }),
  caller_origin: fc.constantFrom("principal", "unknown", "trusted_system"),
  input: jsonArb,
});

const requestArb: fc.Arbitrary<AdmissionRequest> = fc.record({
  workflow_id: idArb,
  workflow_version_id: optId,
  expected_workflow_version_id: optId,
  execution_authority_id: optId,
  hold_writes: fc.option(fc.boolean(), { nil: undefined }),
});

const factsArb: fc.Arbitrary<AdmissionFacts> = fc.oneof(
  fc.constant({ stage: "requested_version" as const }),
  fc.record({
    stage: fc.constant("lifecycle" as const),
    lifecycle: fc.option(fc.constantFrom("active", "archived", "draft"), { nil: null }),
  }),
  fc.constant({ stage: "binding" as const }),
  fc.record({
    stage: fc.constant("authority_refusal" as const),
    code: fc.option(fc.constantFrom(...DOWNGRADABLE_AUTHORITY_CODES, "other"), { nil: null }),
    message: fc.string(),
  }),
  fc.record({
    stage: fc.constant("held_model_steps" as const),
    model_step_ids: fc.array(fc.string({ minLength: 1 })),
    unresolved_call_ids: fc.array(fc.string({ minLength: 1 })),
  }),
  fc.record({
    stage: fc.constant("input" as const),
    verdict: fc.oneof(
      fc.constant({ valid: true as const }),
      fc.record({ valid: fc.constant(false as const), errors: fc.array(fc.string()) }),
    ),
  }),
  fc.record({
    stage: fc.constant("replay_candidate" as const),
    workflow_id: nullableId,
    workflow_version_id: nullableId,
  }),
  fc.record({
    stage: fc.constant("replay" as const),
    existing: fc.option(boundaryArb, { nil: null }),
    requested: boundaryArb,
  }),
  fc.record({
    stage: fc.constant("active_version" as const),
    lifecycle: fc.option(fc.constantFrom("active", "archived"), { nil: null }),
    current_version_id: nullableId,
  }),
  fc.record({ stage: fc.constant("active_definition" as const), found: fc.boolean() }),
  fc.record({ stage: fc.constant("repeated_runs" as const), eligible: fc.boolean() }),
  fc.record({
    stage: fc.constant("authority" as const),
    refusal: fc.option(
      fc.record({
        code: fc.constantFrom("execution_authority_expired", "execution_authority_changed"),
        message: fc.constant("refused"),
      }),
      { nil: null },
    ),
  }),
);

describe("sameExecutionBoundary", () => {
  test("matches an identical boundary with structurally equal payloads", () => {
    expect(sameExecutionBoundary(boundary, { ...boundary, input: { a: [1, 2] } })).toBe(true);
  });

  test.each([
    ["binding", { binding: "authorized" }],
    ["execution_authority_id", { execution_authority_id: AUTH }],
    ["workflow_id", { workflow_id: V2 }],
    ["workflow_version_id", { workflow_version_id: V2 }],
    ["execution_mode", { execution_mode: "prod" }],
    ["parent_execution_id", { parent_execution_id: V2 }],
    ["caller_origin", { caller_origin: "unknown" }],
    ["caller_context", { caller_context: null }],
    ["input", { input: { a: [2, 1] } }],
  ] as const)("differs when %s differs", (_field, change) => {
    expect(sameExecutionBoundary(boundary, { ...boundary, ...change })).toBe(false);
  });

  test("property: reflexive", () => {
    fc.assert(
      fc.property(boundaryArb, (b) => {
        expect(sameExecutionBoundary(b, structuredClone(b))).toBe(true);
      }),
      FC,
    );
  });

  test("property: symmetric", () => {
    fc.assert(
      fc.property(boundaryArb, boundaryArb, (a, b) => {
        expect(sameExecutionBoundary(a, b)).toBe(sameExecutionBoundary(b, a));
      }),
      FC,
    );
  });
});

describe("bindingOf and boundaryOfExecution", () => {
  test("an authority id wins over hold_writes", () => {
    expect(bindingOf({ hold_writes: true, execution_authority_id: AUTH })).toBe("authorized");
    expect(bindingOf({ hold_writes: true, execution_authority_id: null })).toBe("held");
    expect(bindingOf({ hold_writes: false, execution_authority_id: null })).toBe("unbound");
  });

  test("maps a persisted row and fills missing identity fields", () => {
    expect(
      boundaryOfExecution(
        {
          hold_writes: true,
          execution_authority_id: null,
          workflow_id: null,
          workflow_version_id: V1,
          execution_mode: "dev",
          parent_execution_id: null,
          caller_context: null,
          caller_origin: null,
        },
        { x: 1 },
      ),
    ).toEqual({
      binding: "held",
      execution_authority_id: null,
      workflow_id: "",
      workflow_version_id: V1,
      execution_mode: "dev",
      parent_execution_id: null,
      caller_context: null,
      caller_origin: "",
      input: { x: 1 },
    });
  });

  test("keeps persisted identity fields", () => {
    const mapped = boundaryOfExecution(
      {
        hold_writes: false,
        execution_authority_id: AUTH,
        workflow_id: WF,
        workflow_version_id: V1,
        execution_mode: "prod",
        parent_execution_id: V2,
        caller_context: { k: 1 },
        caller_origin: "principal",
      },
      null,
    );
    expect(mapped.workflow_id).toBe(WF);
    expect(mapped.caller_origin).toBe("principal");
    expect(mapped.binding).toBe("authorized");
    expect(mapped.parent_execution_id).toBe(V2);
  });
});

describe("decideAdmission", () => {
  test("rejects a prepared version that differs from the requested one", () => {
    expect(
      decideAdmission(
        { ...base, workflow_version_id: V1, expected_workflow_version_id: V2 },
        { stage: "requested_version" },
      ),
    ).toMatchObject({ kind: "rejected", code: "execution_boundary_mismatch" });
    expect(
      decideAdmission(
        { ...base, workflow_version_id: V1, expected_workflow_version_id: V1 },
        { stage: "requested_version" },
      ),
    ).toEqual({ kind: "admitted" });
  });

  test("rejects an archived workflow", () => {
    expect(decideAdmission(base, { stage: "lifecycle", lifecycle: "archived" })).toEqual({
      kind: "rejected",
      code: "workflow_archived",
      message: "this workflow is archived and cannot run until it is restored",
    });
    expect(decideAdmission(base, { stage: "lifecycle", lifecycle: null }).kind).toBe("admitted");
  });

  test("rejects a preparation request that selects a live authority", () => {
    expect(
      decideAdmission(
        { ...base, hold_writes: true, execution_authority_id: AUTH },
        { stage: "binding" },
      ),
    ).toMatchObject({ kind: "rejected", code: "execution_boundary_mismatch" });
    expect(decideAdmission({ ...base, hold_writes: true }, { stage: "binding" }).kind).toBe(
      "admitted",
    );
  });

  test("a held run never reaches a model step: it needs an approved authority", () => {
    const held = (model_step_ids: string[], unresolved_call_ids: string[]) =>
      decideAdmission(base, { stage: "held_model_steps", model_step_ids, unresolved_call_ids });
    expect(held([], [])).toEqual({ kind: "admitted" });
    expect(held(["classify", "sub/sum"], ["other"])).toEqual({
      kind: "rejected",
      code: "execution_authority_required",
      message:
        "this workflow sends step data to the AI model (classify, sub/sum); it runs only under an approved execution authority",
    });
    expect(held([], ["sub"])).toEqual({
      kind: "rejected",
      code: "execution_authority_required",
      message:
        "this workflow calls a workflow whose effects cannot be resolved (sub); it runs only under an approved execution authority",
    });
  });

  test("downgrades a refused authority only for an open request", () => {
    const refusal = {
      stage: "authority_refusal" as const,
      code: "execution_authority_required",
      message: "needs review",
    };
    expect(decideAdmission(base, refusal)).toEqual({ kind: "downgrade" });
    expect(decideAdmission({ ...base, execution_authority_id: AUTH }, refusal).kind).toBe(
      "rejected",
    );
    expect(decideAdmission({ ...base, hold_writes: false }, refusal).kind).toBe("rejected");
    expect(decideAdmission({ ...base, expected_workflow_version_id: V1 }, refusal).kind).toBe(
      "rejected",
    );
    expect(decideAdmission(base, { ...refusal, code: "other" })).toEqual({
      kind: "rejected",
      code: "other",
      message: "needs review",
    });
    expect(decideAdmission(base, { ...refusal, code: null })).toEqual({
      kind: "rejected",
      code: "",
      message: "needs review",
    });
  });

  test("turns an invalid input verdict into input_schema_violation", () => {
    expect(
      decideAdmission(base, { stage: "input", verdict: { valid: false, errors: ["a", "b"] } }),
    ).toEqual({ kind: "rejected", code: "input_schema_violation", message: "a; b" });
    expect(decideAdmission(base, { stage: "input", verdict: { valid: true } }).kind).toBe(
      "admitted",
    );
  });

  test("a replay candidate needs the same workflow and a pinned version", () => {
    expect(
      decideAdmission(base, {
        stage: "replay_candidate",
        workflow_id: WF,
        workflow_version_id: V1,
      }).kind,
    ).toBe("admitted");
    expect(
      decideAdmission(base, {
        stage: "replay_candidate",
        workflow_id: V2,
        workflow_version_id: V1,
      }).kind,
    ).toBe("rejected");
    expect(
      decideAdmission(base, {
        stage: "replay_candidate",
        workflow_id: WF,
        workflow_version_id: null,
      }).kind,
    ).toBe("rejected");
  });

  test("replays the same boundary and rejects a different one", () => {
    expect(
      decideAdmission(base, { stage: "replay", existing: boundary, requested: boundary }),
    ).toEqual({ kind: "replay" });
    expect(
      decideAdmission(base, {
        stage: "replay",
        existing: boundary,
        requested: { ...boundary, execution_mode: "prod" },
      }),
    ).toEqual({
      kind: "rejected",
      code: "execution_boundary_mismatch",
      message: "the idempotency key belongs to a different execution boundary",
    });
    expect(
      decideAdmission(base, { stage: "replay", existing: null, requested: boundary }).kind,
    ).toBe("admitted");
  });

  test("admits only the exact active version", () => {
    const active = {
      stage: "active_version" as const,
      lifecycle: "active",
      current_version_id: V1,
    };
    expect(decideAdmission(base, active).kind).toBe("admitted");
    expect(decideAdmission({ ...base, workflow_version_id: V1 }, active).kind).toBe("admitted");
    expect(decideAdmission({ ...base, workflow_version_id: V2 }, active)).toMatchObject({
      kind: "rejected",
      code: "workflow_version_not_active",
    });
    expect(decideAdmission(base, { ...active, lifecycle: "archived" }).kind).toBe("rejected");
    expect(decideAdmission(base, { ...active, current_version_id: null }).kind).toBe("rejected");
  });

  test("requires the active definition to exist", () => {
    expect(decideAdmission(base, { stage: "active_definition", found: false })).toEqual({
      kind: "rejected",
      code: "workflow_version_not_active",
      message: "active workflow version unavailable",
    });
    expect(decideAdmission(base, { stage: "active_definition", found: true }).kind).toBe(
      "admitted",
    );
  });

  test("requires eligibility for repeated runs", () => {
    expect(decideAdmission(base, { stage: "repeated_runs", eligible: false })).toMatchObject({
      kind: "rejected",
      code: "execution_authority_required",
    });
    expect(decideAdmission(base, { stage: "repeated_runs", eligible: true }).kind).toBe("admitted");
  });

  test("admits when the approval can carry the run and passes its refusal through otherwise", () => {
    expect(decideAdmission(base, { stage: "authority", refusal: null }).kind).toBe("admitted");
    expect(
      decideAdmission(base, {
        stage: "authority",
        refusal: { code: "execution_authority_revoked", message: "revoked" },
      }),
    ).toEqual({ kind: "rejected", code: "execution_authority_revoked", message: "revoked" });
  });

  test("names every rejection with its exact code and message", () => {
    expect(
      decideAdmission(
        { ...base, workflow_version_id: V1, expected_workflow_version_id: V2 },
        { stage: "requested_version" },
      ),
    ).toEqual({
      kind: "rejected",
      code: "execution_boundary_mismatch",
      message: "the prepared workflow version differs from the requested workflow version",
    });
    expect(
      decideAdmission(
        { ...base, hold_writes: true, execution_authority_id: AUTH },
        { stage: "binding" },
      ),
    ).toEqual({
      kind: "rejected",
      code: "execution_boundary_mismatch",
      message: "a preparation request cannot also select a live authority",
    });
    expect(
      decideAdmission(base, {
        stage: "replay_candidate",
        workflow_id: V2,
        workflow_version_id: V1,
      }),
    ).toEqual({
      kind: "rejected",
      code: "execution_boundary_mismatch",
      message: "the idempotency key belongs to a different execution boundary",
    });
    expect(
      decideAdmission(base, {
        stage: "active_version",
        lifecycle: "draft",
        current_version_id: V1,
      }),
    ).toEqual({
      kind: "rejected",
      code: "workflow_version_not_active",
      message: "only the exact active workflow version can be admitted",
    });
    expect(decideAdmission(base, { stage: "repeated_runs", eligible: false })).toEqual({
      kind: "rejected",
      code: "execution_authority_required",
      message: "this workflow requires concrete-run review for its current effects",
    });
    expect(
      decideAdmission(base, {
        stage: "authority",
        refusal: {
          code: "execution_authority_changed",
          message: "the execution authority no longer matches the current effect boundary",
        },
      }),
    ).toEqual({
      kind: "rejected",
      code: "execution_authority_changed",
      message: "the execution authority no longer matches the current effect boundary",
    });
  });

  test("a version check needs both the prepared and the requested version", () => {
    expect(
      decideAdmission({ ...base, workflow_version_id: V1 }, { stage: "requested_version" }),
    ).toEqual({ kind: "admitted" });
    expect(
      decideAdmission(
        { ...base, expected_workflow_version_id: V2 },
        { stage: "requested_version" },
      ),
    ).toEqual({ kind: "admitted" });
  });

  test("a live authority is a conflict only for a preparation request", () => {
    expect(
      decideAdmission(
        { ...base, hold_writes: false, execution_authority_id: AUTH },
        { stage: "binding" },
      ),
    ).toEqual({ kind: "admitted" });
    expect(
      decideAdmission({ ...base, execution_authority_id: AUTH }, { stage: "binding" }),
    ).toEqual({ kind: "admitted" });
  });

  test("property: total — never throws and always returns a known decision", () => {
    fc.assert(
      fc.property(requestArb, factsArb, (request, facts) => {
        const decision = decideAdmission(request, facts);
        expect(["admitted", "replay", "downgrade", "rejected"]).toContain(decision.kind);
        if (decision.kind === "rejected") expect(typeof decision.code).toBe("string");
      }),
      FC,
    );
  });

  test("property: replay is decided by sameExecutionBoundary alone", () => {
    fc.assert(
      fc.property(requestArb, boundaryArb, boundaryArb, (request, existing, requested) => {
        const decision = decideAdmission(request, { stage: "replay", existing, requested });
        expect(decision.kind === "replay").toBe(sameExecutionBoundary(existing, requested));
      }),
      FC,
    );
  });
});
