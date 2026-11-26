import { expect, test } from "bun:test";
import {
  compileWorkflowEffectManifest,
  type ResolvedEffectBinding,
} from "../core/effect-manifest.ts";
import { requestDigest } from "../core/request-protocol.ts";
import { recordsCreatedEndpoint } from "../owned-resources.ts";
import { type RequestStep, WorkflowDefSchema } from "../types.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const connector = "00000000-0000-4000-8000-000000000004";

const definitionWith = (path: string, id_path: string) =>
  WorkflowDefSchema.parse({
    name: "Jobs",
    steps: [
      {
        id: "make",
        kind: "request",
        connector_id: connector,
        method: "POST",
        path,
        body: { name: "nightly" },
        records_created: { id_path },
      },
    ],
  });

function bindingFor(step: RequestStep, extra: Partial<ResolvedEffectBinding> = {}) {
  const created = recordsCreatedEndpoint(step);
  return {
    tenant_id: tenant,
    step_id: step.id,
    connector_id: connector,
    driver: "http" as const,
    environment: "dev" as const,
    request_digest: requestDigest(step),
    target: `https://api.example.test${step.path}`,
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    ...(created ? { records_created: created } : {}),
    ...extra,
  };
}

function compile(definition: ReturnType<typeof definitionWith>, bindings: ResolvedEffectBinding[]) {
  return compileWorkflowEffectManifest({
    tenant_id: tenant,
    workflow_id: "00000000-0000-4000-8000-000000000002",
    workflow_version_id: "00000000-0000-4000-8000-000000000003",
    execution_environment: "dev",
    execution_options_digest: "c".repeat(64),
    definition,
    bindings,
  });
}

const reviewed = definitionWith("/jobs", "data.id");
const reviewedStep = reviewed.steps[0] as RequestStep;

test("the reviewed effect names the recorded id and its collection", () => {
  const accepted = compile(reviewed, [bindingFor(reviewedStep)]);
  expect(accepted.manifest.issues).toEqual([]);
  expect(accepted.manifest.effects[0]?.records_created).toEqual({
    id_path: "data.id",
    collection_path: "/jobs",
  });
});

test.each([
  ["another id path", definitionWith("/jobs", "data.other")],
  ["another creating path", definitionWith("/users", "data.id")],
])("%s changes the digest and needs a new approval", (_name, changed) => {
  const step = changed.steps[0] as RequestStep;
  expect(requestDigest(step)).not.toBe(requestDigest(reviewedStep));
  const stale = compile(changed, [bindingFor(reviewedStep)]);
  expect(stale.manifest.issues).toContainEqual({ step_id: "make", code: "binding_mismatch" });
  expect(stale.eligible_for_repeated_runs).toBe(false);
});

test("an approval that does not carry the recorded endpoint does not cover the step", () => {
  const { records_created: _dropped, ...bare } = bindingFor(reviewedStep);
  expect(compile(reviewed, [bare]).manifest.issues).toEqual([
    { step_id: "make", code: "binding_mismatch" },
  ]);
});
