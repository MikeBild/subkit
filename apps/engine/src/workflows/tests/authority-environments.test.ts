import { expect, test } from "bun:test";
import { collectWorkflowConnectorReferences } from "../../execution/prepared-workflow-references.ts";
import { describeAuthorityEnvironments } from "../authority-environments.ts";
import { summarizeAuthorityEnvironments } from "../operating-status.ts";
import type { WorkflowDef } from "../types.ts";

const missing = {
  code: "connector_missing" as const,
  step_id: "fetch",
  connector_id: null,
  connector_name: "SubKit Support Admin",
};

test("both possible environments need no sentence", () => {
  expect(
    describeAuthorityEnvironments({
      dev: { possible: true, reasons: [] },
      prod: { possible: true, reasons: [] },
    }),
  ).toBeNull();
});

test("one possible environment names what is missing in the other", () => {
  expect(
    describeAuthorityEnvironments({
      dev: { possible: true, reasons: [] },
      prod: { possible: false, reasons: [missing, { ...missing, step_id: "send" }] },
    }),
  ).toBe("Possible only in Test: SubKit Support Admin does not exist in Production.");
});

test("no possible environment names every block", () => {
  expect(
    describeAuthorityEnvironments({
      dev: {
        possible: false,
        reasons: [{ ...missing, code: "connector_without_sign_in" }],
      },
      prod: { possible: false, reasons: [missing] },
    }),
  ).toBe(
    "Not possible in Test or Production yet: SubKit Support Admin has no sign-in in Test; SubKit Support Admin does not exist in Production.",
  );
});

const FIRST_ID = "00000000-0000-4000-8000-000000000001";

const authority = (execution_environment: "dev" | "prod", ready_for_new_run: boolean) => ({
  execution_environment,
  ready_for_new_run,
  state: ready_for_new_run ? ("approved" as const) : ("revoked" as const),
  active_version: ready_for_new_run,
  valid_from: "2026-01-01T00:00:00.000Z",
  valid_until: null,
  revoked_at: ready_for_new_run ? null : "2026-01-02T00:00:00.000Z",
  remaining_runs: null,
  max_runs: null,
  reserved_runs: 0,
});

test("authority environment summary covers only the current usable environments", () => {
  expect(summarizeAuthorityEnvironments([authority("dev", true)])).toEqual({
    dev: { state: "approved", ready_for_new_run: true },
    prod: null,
  });
  expect(summarizeAuthorityEnvironments([authority("dev", true), authority("prod", true)])).toEqual(
    {
      dev: { state: "approved", ready_for_new_run: true },
      prod: { state: "approved", ready_for_new_run: true },
    },
  );
  expect(summarizeAuthorityEnvironments(null)).toEqual({ dev: null, prod: null });
});

test("connector references come from request steps and placeholders, attributed to a step", () => {
  const definition = {
    name: "references",
    steps: [
      { id: "direct", kind: "request", connector_id: FIRST_ID, method: "GET", path: "/a" },
      {
        id: "tokens",
        kind: "request",
        method: "GET",
        url: "${connector.billing.base_url}/x",
        headers: { authorization: "Bearer ${cred.billing.token}" },
      },
    ],
  } as unknown as WorkflowDef;
  const references = collectWorkflowConnectorReferences(definition);
  expect([...references.ids]).toEqual([[FIRST_ID, "direct"]]);
  expect([...references.slugs]).toEqual([["billing", { credential: true, step_id: "tokens" }]]);
  expect(references.refusals).toEqual([]);
});

test("references of a called workflow are attributed to the calling step", () => {
  const child = {
    name: "child",
    steps: [{ id: "inner", kind: "request", method: "GET", url: "${connector.crm.base_url}" }],
  } as unknown as WorkflowDef;
  const references = collectWorkflowConnectorReferences(child, undefined, "delegate");
  expect([...references.slugs]).toEqual([["crm", { credential: false, step_id: "delegate" }]]);
});

test("a request step with an invalid connector id is refused", () => {
  const definition = {
    name: "invalid",
    steps: [{ id: "bad", kind: "request", connector_id: "not-a-uuid", method: "GET", path: "/" }],
  } as unknown as WorkflowDef;
  expect(collectWorkflowConnectorReferences(definition).refusals).toEqual([
    { reason: "missing", step_id: "bad" },
  ]);
});
