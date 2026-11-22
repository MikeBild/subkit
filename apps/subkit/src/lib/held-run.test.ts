import { describe, expect, test } from "bun:test";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { heldRunBlock, heldRunBlockForExecution, heldStepKeys, isHeldRun } from "./held-run.ts";

type Schemas = components["schemas"];

const client = { base: "https://engine.example.test" };

const outcome = (
  kind: Schemas["ExecutionOutcome"]["kind"],
  held = 1,
): Schemas["ExecutionOutcome"] => ({
  kind,
  failed_step: null,
  cause_class: null,
  error_code: null,
  refusal_reason: null,
  connector: null,
  steps: { total: 2, succeeded: 1, failed: 0, held, skipped: 0 },
  output_contract: "none",
  rerun_safety: { mode: "prepare_only", reason: "fixture" },
});

const executionDetail = (
  overrides: Partial<Schemas["ExecutionDetail"]> = {},
): Schemas["ExecutionDetail"] => ({
  id: "ex-1",
  execution_id: "ex-1",
  error: null,
  workflow_id: "wf-1",
  workflow_name: null,
  workflow_version_id: null,
  execution_authority_id: null,
  execution_environment: "prod",
  permission_basis: null,
  permission_phase: null,
  permission_checked_at: null,
  source_kind: "saved",
  source_ref: null,
  status: "succeeded",
  request_source: "cli",
  caller: {
    kind: "user",
    principal_id: null,
    provider: null,
    product_id: null,
    verified_by: null,
    channel: "cli",
    origin_execution_id: null,
  },
  parent_execution_id: null,
  started_at: null,
  finished_at: null,
  created_at: "2026-01-01T00:00:00Z",
  trace_id: null,
  outcome: outcome("held"),
  result_markdown: null,
  result_markdown_truncated: false,
  ...overrides,
});

const executionStep = (
  overrides: Partial<Schemas["ExecutionStep"]> = {},
): Schemas["ExecutionStep"] => ({
  id: "st-1",
  step_key: "load",
  step_index: 0,
  kind: "http",
  status: "succeeded",
  held: false,
  duration_ms: null,
  retry_count: 0,
  result_storage_uri: null,
  result_sha256: null,
  result_preview: null,
  credential_snapshots: [],
  started_at: null,
  finished_at: null,
  ...overrides,
});

const steps = [
  { step_key: "load", status: "succeeded" },
  { step_key: "send_mail", status: "succeeded", request_meta: { extras: { held: true } } },
];

const contractSteps = [
  executionStep(),
  executionStep({ id: "st-2", step_key: "send_mail", request_meta: { extras: { held: true } } }),
];

describe("heldRunBlock", () => {
  test("names the consequence, the held step and one full approval link", () => {
    const block = heldRunBlock(
      client,
      { outcome: outcome("held"), workflow_id: "wf-1", workflow_name: "Weekly mail" },
      steps,
    );
    expect(block).toBe(
      [
        "Held: nothing was written.",
        "The run only prepared its work. No data was changed anywhere. Writes need an approval for this workflow.",
        "Held steps: send_mail",
        "Approve “Weekly mail” here: https://engine.example.test/cockpit/workflows/wf-1",
      ].join("\n"),
    );
    expect(block).not.toContain("succeeded");
  });

  test("keeps an engine path prefix in the link", () => {
    const block = heldRunBlock(
      { base: "https://host.example.test/engine" },
      { outcome: outcome("held"), workflow_id: "wf-1" },
      steps,
    );
    expect(block).toContain(
      "Approve here: https://host.example.test/engine/cockpit/workflows/wf-1",
    );
  });

  test("a run that wrote normally has no block", () => {
    expect(heldRunBlock(client, { outcome: outcome("succeeded", 0), workflow_id: "wf-1" })).toBe(
      null,
    );
  });

  test("without an outcome the run response decides", () => {
    expect(isHeldRun({ hold_writes: true }, steps)).toBe(true);
    expect(isHeldRun({ hold_writes: true }, [{ step_key: "a" }])).toBe(false);
    expect(isHeldRun({ hold_writes: false }, steps)).toBe(false);
  });

  test("held step keys come from the step rows", () => {
    expect(heldStepKeys([{ step_key: "a", held: true }, ...steps])).toEqual(["a", "send_mail"]);
  });
});

describe("heldRunBlockForExecution", () => {
  test("reads the finished run and returns the block", async () => {
    const block = await heldRunBlockForExecution(
      {
        ...client,
        getExecution: async () => executionDetail(),
        executionSteps: async () => ({ items: contractSteps }),
      },
      "ex-1",
    );
    expect(block).toContain("/cockpit/workflows/wf-1");
  });

  test("a read failure never hides the run result", async () => {
    const block = await heldRunBlockForExecution(
      {
        ...client,
        getExecution: async () => {
          throw new Error("down");
        },
        executionSteps: async () => ({ items: [] }),
      },
      "ex-1",
    );
    expect(block).toBe(null);
  });
});
