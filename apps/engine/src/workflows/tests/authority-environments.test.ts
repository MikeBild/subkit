import { expect, test } from "bun:test";
import { collectWorkflowConnectorReferences } from "../../execution/prepared-workflow-references.ts";
import { describeAuthorityEnvironments } from "../authority-environments.ts";
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
