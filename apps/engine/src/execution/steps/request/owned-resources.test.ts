import { describe, expect, test } from "bun:test";
import { RequestStepSchema } from "../../../workflows/types.ts";
import type { StepResult } from "../../types.ts";
import type { RequestDispatch, RunRequestStepParams } from "./drivers/context.ts";
import {
  claimDeclaredOwnedDelete,
  recordStepCreatedResources,
  settleClaimedOwnedDelete,
} from "./owned-resources.ts";

const CONNECTOR = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-0000000000aa";
const unavailable = {
  transaction: async () => {
    throw new Error("database unavailable");
  },
} as unknown as RunRequestStepParams["ctx"]["db"];

const ctx = {
  db: unavailable,
  tenant_id: ID,
  workflow_id: ID,
  workflow_version_id: ID,
  execution_mode: "dev",
  execution_id: ID,
} as RunRequestStepParams["ctx"];

const make = RequestStepSchema.parse({
  id: "make",
  kind: "request",
  method: "POST",
  connector_id: CONNECTOR,
  path: "/jobs",
  records_created: { id_path: "data.id" },
});

const succeeded = (output: unknown): StepResult => ({
  status: "succeeded",
  retry_count: 0,
  duration_ms: 1,
  output,
});

describe("recording created ids on a request step", () => {
  test("an output without an id fails the step with a named cause", async () => {
    const result = await recordStepCreatedResources({ ctx, step: make, scope: {} }, succeeded({}));
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "created_resource_unrecorded",
      message:
        "The request succeeded, but the created id was not recorded: `data.id` does not resolve to one id (a single string or whole number). A later removal of it will be refused; correct `records_created.id_path`.",
    });
  });

  test("a ledger that cannot be written fails the step", async () => {
    const result = await recordStepCreatedResources(
      { ctx, step: make, scope: {} },
      succeeded({ data: { id: "job-1" } }),
    );
    expect(result.error?.code).toBe("created_resource_unrecorded");
    expect(result.error?.message).toContain("the ownership ledger could not be written");
  });

  test.each([
    ["a held run", { ...ctx, hold_writes: true }, succeeded({ data: { id: "a" } })],
    ["a held step", ctx, { ...succeeded({ data: { id: "a" } }), held: true as const }],
    ["a failed step", ctx, { ...succeeded(null), status: "failed" as const }],
  ])("%s records nothing", async (_name, runCtx, outcome) => {
    expect(
      await recordStepCreatedResources(
        { ctx: runCtx as RunRequestStepParams["ctx"], step: make, scope: {} },
        outcome,
      ),
    ).toBe(outcome);
  });

  test("a step without records_created is left alone", async () => {
    const plain = RequestStepSchema.parse({ ...make, records_created: undefined });
    const outcome = succeeded({ data: { id: "a" } });
    expect(await recordStepCreatedResources({ ctx, step: plain, scope: {} }, outcome)).toBe(
      outcome,
    );
  });
});

describe("claiming a removal", () => {
  const dispatch = (step: unknown) =>
    ({
      p: { ctx, step, scope: {} },
      clock: { now: () => 5 },
      start: 0,
    }) as unknown as RequestDispatch;

  test("a step without the rule is not claimed", async () => {
    const step = RequestStepSchema.parse({ ...make, method: "DELETE", records_created: undefined });
    expect(await claimDeclaredOwnedDelete(dispatch(step), null, "https://a.test/jobs")).toBeNull();
  });

  test("a rule without a compiled boundary is refused before anything is sent", async () => {
    const step = RequestStepSchema.parse({
      id: "drop",
      kind: "request",
      method: "DELETE",
      connector_id: CONNECTOR,
      path: "/jobs/${scope.make.data.id}",
      max_retries: 0,
      boundary: {
        variables: { "scope.make.data.id": { created_by_workflow: true } },
        max_body_bytes: 0,
        max_calls: 1,
        destructive: true,
      },
    });
    const claimed = await claimDeclaredOwnedDelete(dispatch(step), null, "https://a.test/jobs/x");
    expect(claimed && "result" in claimed ? claimed.result.error?.code : null).toBe(
      "delete_target_not_created_by_workflow",
    );
  });

  test("a paged removal is refused before anything is claimed or sent", async () => {
    const step = RequestStepSchema.parse({
      id: "drop",
      kind: "request",
      method: "DELETE",
      connector_id: CONNECTOR,
      path: "/jobs/${scope.make.data.id}",
      pagination: {
        strategy: "cursor",
        cursor_request_param: "start_cursor",
        cursor_response_path: "$.next_cursor",
        max_pages: 3,
      },
      boundary: {
        variables: { "scope.make.data.id": { created_by_workflow: true } },
        max_body_bytes: 0,
        max_calls: 1,
        destructive: true,
      },
    });
    const claimed = await claimDeclaredOwnedDelete(dispatch(step), null, "https://a.test/jobs/x");
    expect(claimed && "result" in claimed ? claimed.result.error?.code : null).toBe(
      "created_by_workflow_misplaced",
    );
  });

  test("an outcome that cannot be settled keeps the id reserved without throwing", async () => {
    const claim = {
      correlation: {
        collection_path: "/jobs",
        tenant_id: ID,
        workflow_id: ID,
        workflow_version_id: ID,
        environment: "dev" as const,
        connector_id: CONNECTOR,
        execution_id: ID,
        step_id: "drop",
      },
      resource_keys: ["job-1"],
      sensitive: true,
    };
    expect(await settleClaimedOwnedDelete(claim, unavailable, succeeded(null))).toBeUndefined();
  });
});
