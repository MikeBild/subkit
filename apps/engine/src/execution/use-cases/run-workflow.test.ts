import { describe, expect, test } from "bun:test";
import type { PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import type { RunResult } from "../types.ts";
import {
  type AdmittedWorkflowRun,
  completedRun,
  createRunWorkflow,
  isBearerProductPrincipal,
  principalExecutionEnvironment,
  type RunWorkflowDeps,
  type RunWorkflowRequest,
} from "./run-workflow.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const WORKFLOW = "00000000-0000-4000-8000-000000000002";
const VERSION = "00000000-0000-4000-8000-000000000003";
const EXECUTION = "00000000-0000-4000-8000-000000000004";

const operator: ResolvedPrincipal = {
  provider: "api_key",
  kind: "user",
  id: "user-1",
  tenant_id: TENANT,
  roles: ["admin"],
};

const product: ResolvedPrincipal = {
  ...operator,
  product_id: "shop",
  auth_source: { kind: "external_bearer" } as NonNullable<ResolvedPrincipal["auth_source"]>,
};

type AdmitPort = NonNullable<RunWorkflowDeps["admit"]>;
type RunPort = NonNullable<RunWorkflowDeps["run"]>;

const boss = {} as PgBoss;
const db = {} as Db;

function admitted(overrides: Partial<AdmittedWorkflowRun> = {}): AdmittedWorkflowRun {
  return {
    execution_id: EXECUTION,
    execution_authority_id: null,
    workflow_version_id: VERSION,
    input: { a: 1 },
    status: "queued",
    replayed: false,
    hold_writes: true,
    ...overrides,
  } as AdmittedWorkflowRun;
}

const runResult = {
  execution_id: EXECUTION,
  status: "succeeded",
  steps: [],
} as unknown as RunResult;

interface Recorder {
  calls: string[];
  audits: Array<Record<string, unknown>>;
  admitInput: Array<Record<string, unknown>>;
  runOptions: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  finalized: string[];
}

function fakes(overrides: Partial<RunWorkflowDeps> = {}): { deps: RunWorkflowDeps; rec: Recorder } {
  const rec: Recorder = {
    calls: [],
    audits: [],
    admitInput: [],
    runOptions: [],
    jobs: [],
    finalized: [],
  };
  const deps: RunWorkflowDeps = {
    db,
    gate: async (p) => {
      rec.calls.push(`gate:${p.request_source}:${p.tool ?? ""}`);
      return { allow: true, workflow_permission: null };
    },
    admit: (async (raw: unknown) => {
      rec.calls.push("admit");
      rec.admitInput.push(raw as Record<string, unknown>);
      return admitted();
    }) as unknown as AdmitPort,
    assertAuthorityCurrent: async () => {
      rec.calls.push("authority");
    },
    auditRefusal: async (input) => {
      rec.audits.push(input as unknown as Record<string, unknown>);
    },
    enqueue: async (_db, _boss, _execution_id, job) => {
      rec.jobs.push(job as unknown as Record<string, unknown>);
    },
    finalizeFailed: async (_db, _tenant, execution_id, message) => {
      rec.finalized.push(`${execution_id}:${message}`);
    },
    run: (async (p: { options?: Record<string, unknown> }) => {
      rec.runOptions.push(p.options ?? {});
      return runResult;
    }) as unknown as RunPort,
    ...overrides,
  };
  return { deps, rec };
}

function request(overrides: Partial<RunWorkflowRequest> = {}): RunWorkflowRequest {
  return {
    principal: operator,
    workflow_id: WORKFLOW,
    execution_environment: "dev",
    request_source: "api",
    input: { a: 1 },
    authorization: { kind: "granted", workflow_permission: null },
    dispatch: { mode: "inline" },
    ...overrides,
  } as RunWorkflowRequest;
}

function refusing(code: string, message = `${code} refused`, details?: unknown) {
  return (async () => {
    throw Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
  }) as unknown as AdmitPort;
}

describe("runWorkflow", () => {
  test("prechecks refuse before any gate or admission", async () => {
    const { deps, rec } = fakes();
    const outcome = await createRunWorkflow(deps).runWorkflow(
      request({ idempotency_key: "", authorization: { kind: "gate", via: "mcp" } }),
    );
    expect(outcome).toMatchObject({ kind: "rejected", code: "bad_request" });
    expect(rec.calls).toEqual([]);
  });

  test("a product caller asking for a preparation is refused", async () => {
    const { deps, rec } = fakes();
    const outcome = await createRunWorkflow(deps).runWorkflow(
      request({ principal: product, hold_writes: true }),
    );
    expect(outcome).toMatchObject({ kind: "rejected", code: "product_preparation_forbidden" });
    expect(rec.calls).toEqual([]);
  });

  test("a product caller is admitted without a held downgrade", async () => {
    const { deps, rec } = fakes();
    await createRunWorkflow(deps).runWorkflow(request({ principal: product }));
    expect(rec.admitInput[0]?.hold_writes).toBe(false);
  });

  test("the gate authorizes before admission and a denial stops the run", async () => {
    const { deps, rec } = fakes({
      gate: async () => ({ allow: false, reason: "no_role", error_message: "permission_denied" }),
    });
    const outcome = await createRunWorkflow(deps).runWorkflow(
      request({
        authorization: { kind: "gate", via: "chat", tool: "run_workflow", workflow_slug: "s" },
      }),
    );
    expect(outcome).toEqual({
      kind: "rejected",
      code: "permission_denied",
      message: "permission_denied",
      reason: "no_role",
      refusal: "permission_denied",
    });
    expect(rec.calls).toEqual([]);
  });

  test("a gated run passes its permission to admission", async () => {
    const { deps, rec } = fakes();
    const outcome = await createRunWorkflow(deps).runWorkflow(
      request({ authorization: { kind: "gate", via: "mcp", tool: "wf_x" } }),
    );
    expect(outcome.kind).toBe("completed");
    expect(rec.calls).toEqual(["gate:mcp:wf_x", "admit"]);
  });

  test("an admission refusal is audited with the surface context and returned", async () => {
    const { deps, rec } = fakes({ admit: refusing("workflow_archived", "archived") });
    const outcome = await createRunWorkflow(deps).runWorkflow(
      request({ request_source: "mcp", audit_extra: { tool: "wf_x" } }),
    );
    expect(outcome).toMatchObject({
      kind: "rejected",
      code: "workflow_archived",
      message: "archived",
      refusal: "boundary",
    });
    expect(rec.audits).toEqual([
      {
        tenant_id: TENANT,
        reason: "workflow_archived",
        message: "archived",
        workflow_id: WORKFLOW,
        request_source: "mcp",
        actor_id: "user-1",
        actor_type: "user",
        extra: { tool: "wf_x" },
      },
    ]);
  });

  test("a caller budget refusal is audited and keeps its details", async () => {
    const { deps, rec } = fakes({
      admit: refusing("rate_limited", "limit", { usage: { usedToday: 3, dailyLimit: 3 } }),
    });
    const outcome = await createRunWorkflow(deps).runWorkflow(request());
    expect(outcome).toMatchObject({
      kind: "rejected",
      refusal: "budget",
      details: { usage: { usedToday: 3, dailyLimit: 3 } },
    });
    expect(rec.audits).toHaveLength(1);
  });

  test("an input schema violation is returned without an audit row", async () => {
    const { deps, rec } = fakes({ admit: refusing("input_schema_violation") });
    const outcome = await createRunWorkflow(deps).runWorkflow(request());
    expect(outcome).toMatchObject({ kind: "rejected", refusal: "input" });
    expect(rec.audits).toEqual([]);
  });

  test("an unexpected admission error propagates", async () => {
    const { deps } = fakes({ admit: refusing("database_down") });
    await expect(createRunWorkflow(deps).runWorkflow(request())).rejects.toThrow(
      "database_down refused",
    );
  });

  test("a downgrade is audited before the run continues", async () => {
    const { deps, rec } = fakes({
      admit: (async () =>
        admitted({
          downgraded_from: { code: "execution_authority_required", message: "no authority" },
        })) as unknown as AdmitPort,
    });
    const outcome = await createRunWorkflow(deps).runWorkflow(
      request({ audit_extra: { rerun_of: "e0" } }),
    );
    expect(outcome.kind).toBe("completed");
    expect(rec.audits).toEqual([
      {
        tenant_id: TENANT,
        reason: "execution_authority_required",
        message: "no authority",
        workflow_id: WORKFLOW,
        execution_id: EXECUTION,
        request_source: "api",
        actor_id: "user-1",
        actor_type: "user",
        extra: { downgraded_to_preparation: true, rerun_of: "e0" },
      },
    ]);
  });

  test("a settled replay returns without dispatch", async () => {
    const { deps, rec } = fakes({
      admit: (async () =>
        admitted({ replayed: true, status: "succeeded" })) as unknown as AdmitPort,
    });
    const outcome = await createRunWorkflow(deps).runWorkflow(request({ idempotency_key: "k" }));
    expect(outcome.kind).toBe("replayed");
    expect(rec.runOptions).toEqual([]);
  });

  test("a queued replay is dispatched again unless the surface returns it", async () => {
    const replayQueued = (async () =>
      admitted({ replayed: true, status: "queued" })) as unknown as AdmitPort;
    const dispatched = fakes({ admit: replayQueued });
    expect(
      (await createRunWorkflow(dispatched.deps).runWorkflow(request({ idempotency_key: "k" })))
        .kind,
    ).toBe("completed");
    const returned = fakes({ admit: replayQueued });
    expect(
      (
        await createRunWorkflow(returned.deps).runWorkflow(
          request({ idempotency_key: "k", replayed_queued: "return" }),
        )
      ).kind,
    ).toBe("replayed");
  });

  test("inline runs pass the admitted boundary and dispatch options", async () => {
    const { deps, rec } = fakes();
    const signal = new AbortController().signal;
    const outcome = await createRunWorkflow(deps).runWorkflow(
      request({
        parent_execution_id: "parent",
        dispatch: { mode: "inline", signal, trace_id: null, refusal_answered_to_caller: true },
      }),
    );
    expect(outcome).toEqual({ kind: "completed", admitted: admitted(), result: runResult });
    expect(rec.runOptions).toEqual([
      {
        existing_execution_id: EXECUTION,
        principal: operator,
        execution_mode: "dev",
        request_source: "api",
        parent_execution_id: "parent",
        hold_writes: true,
        self_healing: { enabled: false },
        signal,
        trace_id: null,
      },
    ]);
  });

  test("a refusal while running is audited against the execution", async () => {
    const { deps, rec } = fakes({
      admit: (async () => admitted({ hold_writes: false })) as unknown as AdmitPort,
      run: (async () => {
        throw Object.assign(new Error("credential gone"), {
          code: "prepared_credential_unavailable",
        });
      }) as unknown as RunPort,
    });
    const outcome = await createRunWorkflow(deps).runWorkflow(request());
    expect(outcome).toMatchObject({
      kind: "rejected",
      code: "prepared_credential_unavailable",
      execution_id: EXECUTION,
    });
    expect(rec.audits[0]).toMatchObject({ execution_id: EXECUTION });
  });

  test("background runs return the started execution and settle later", async () => {
    const { deps } = fakes();
    const outcome = await createRunWorkflow(deps).runWorkflow(
      request({ dispatch: { mode: "background" } }),
    );
    if (outcome.kind !== "started") throw new Error(`expected started, got ${outcome.kind}`);
    expect(outcome.admitted.execution_id).toBe(EXECUTION);
    expect((await outcome.settled).kind).toBe("completed");
  });

  test("enqueued runs carry the job and check a live authority first", async () => {
    const { deps, rec } = fakes({
      admit: (async () => admitted({ execution_authority_id: "auth-1" })) as unknown as AdmitPort,
    });
    const outcome = await createRunWorkflow(deps).runWorkflow(
      request({
        idempotency_key: "k",
        execution_authority_id: "auth-1",
        dispatch: { mode: "enqueue", boss, trace_id: "t1" },
      }),
    );
    expect(outcome.kind).toBe("queued");
    expect(rec.calls).toEqual(["authority"]);
    expect(rec.jobs).toEqual([
      {
        tenant_id: TENANT,
        workflow_id: WORKFLOW,
        execution_id: EXECUTION,
        request_source: "api",
        trace_id: "t1",
        execution_mode: "dev",
      },
    ]);
  });

  test("a stale authority before enqueue is a refusal", async () => {
    const { deps, rec } = fakes({
      admit: (async () => admitted({ execution_authority_id: "auth-1" })) as unknown as AdmitPort,
      assertAuthorityCurrent: async () => {
        throw Object.assign(new Error("changed"), { code: "execution_authority_changed" });
      },
    });
    const outcome = await createRunWorkflow(deps).runWorkflow(
      request({ idempotency_key: "k", dispatch: { mode: "enqueue", boss } }),
    );
    expect(outcome).toMatchObject({ kind: "rejected", code: "execution_authority_changed" });
    expect(rec.jobs).toEqual([]);
    expect(rec.audits).toHaveLength(1);
  });

  test("an enqueue failure finalizes a run without an idempotency key", async () => {
    const failure = new Error("queue down");
    const { deps, rec } = fakes({
      enqueue: async () => {
        throw failure;
      },
    });
    const outcome = await createRunWorkflow(deps).runWorkflow(
      request({ parent_execution_id: "parent", dispatch: { mode: "enqueue", boss } }),
    );
    expect(outcome).toEqual({ kind: "enqueue_failed", admitted: admitted(), error: failure });
    expect(rec.finalized).toEqual([`${EXECUTION}:The rerun could not be enqueued.`]);
  });

  test("an enqueue failure keeps a keyed run for its retry", async () => {
    const { deps, rec } = fakes({
      enqueue: async () => {
        throw new Error("queue down");
      },
    });
    const outcome = await createRunWorkflow(deps).runWorkflow(
      request({ idempotency_key: "k", dispatch: { mode: "enqueue", boss } }),
    );
    expect(outcome.kind).toBe("enqueue_failed");
    expect(rec.finalized).toEqual([]);
  });
});

describe("authorize", () => {
  test("forwards the approval resource and returns the grant", async () => {
    const seen: unknown[] = [];
    const { deps } = fakes({
      gate: async (p) => {
        seen.push(p);
        return { allow: true, workflow_permission: null };
      },
    });
    const approval = { resource_type: "tool_approval", approval_id: "ap-1" } as never;
    const grant = await createRunWorkflow(deps).authorize({
      principal: operator,
      workflow_id: WORKFLOW,
      via: "fast_path",
      tool: "run_workflow",
      workflow_slug: "s",
      approval,
    });
    expect(grant).toEqual({ kind: "authorized", workflow_id: WORKFLOW, workflow_permission: null });
    expect(seen[0]).toMatchObject({ request_source: "fast_path", approval, workflow_slug: "s" });
  });
});

describe("completedRun", () => {
  test("unwraps a completed run and throws for the rest", () => {
    const completed = { kind: "completed" as const, admitted: admitted(), result: runResult };
    expect(completedRun(completed)).toBe(completed);
    const cause = new Error("archived");
    expect(() =>
      completedRun({
        kind: "rejected",
        code: "workflow_archived",
        message: "archived",
        refusal: "boundary",
        cause,
      }),
    ).toThrow(cause);
    expect(() =>
      completedRun({ kind: "replayed", admitted: admitted({ replayed: true, status: "running" }) }),
    ).toThrow(`execution ${EXECUTION} already ran under this idempotency key (status: running)`);
  });
});

describe("principal helpers", () => {
  test("only an external bearer product principal counts as a product caller", () => {
    expect(isBearerProductPrincipal(product)).toBe(true);
    expect(isBearerProductPrincipal(operator)).toBe(false);
    expect(isBearerProductPrincipal({ ...operator, product_id: "shop" })).toBe(false);
  });

  test("an operator picks the requested environment", () => {
    expect(principalExecutionEnvironment(operator, "prod")).toBe("prod");
    expect(principalExecutionEnvironment(operator, null)).toBe("dev");
  });
});
