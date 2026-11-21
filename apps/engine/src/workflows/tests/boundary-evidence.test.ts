import { expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import { compileWorkflowEffectManifest, type ResolvedEffectBinding } from "../effect-manifest.ts";
import { remedyFor } from "../issue-remedies.ts";
import { storageBoundary, storageTarget } from "../storage-boundary.ts";
import { WorkflowDefSchema } from "../types.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const workflow = "00000000-0000-4000-8000-000000000002";
const version = "00000000-0000-4000-8000-000000000003";
const connector = "00000000-0000-4000-8000-000000000004";
const BASE = "https://store.test/bucket/";

function fixture(key_prefix: string) {
  const definition = WorkflowDefSchema.parse(
    JSON.parse(
      JSON.stringify({
        name: "store",
        steps: [
          {
            id: "store_manifest",
            kind: "request",
            connector_id: connector,
            method: "PUT",
            body: "payload",
            s3: {
              key: "${scope.build.data.manifest.key}",
              scope: { key_prefix, max_bytes: 1_000_000 },
            },
          },
        ],
      }),
    ),
  );
  const step = definition.steps[0];
  const storage = storageBoundary(step as never, BASE);
  if (!storage) throw new Error("fixture: storage boundary did not compile");
  const binding: ResolvedEffectBinding = {
    tenant_id: tenant,
    step_id: "store_manifest",
    connector_id: connector,
    driver: "s3",
    environment: "dev",
    request_digest: workflowJsonDigest(step),
    target: storageTarget(storage),
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    storage,
  };
  return {
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "dev" as const,
    execution_options_digest: "c".repeat(64),
    definition,
    bindings: [binding],
  };
}

const codes = (result: ReturnType<typeof compileWorkflowEffectManifest>) =>
  result.manifest.issues.map((issue) => issue.code);

test("a key the step really wrote, outside the folder it declares, blocks the approval", () => {
  const result = compileWorkflowEffectManifest({
    ...fixture("v1/latest/"),
    observed_keys: [
      {
        step_id: "store_manifest",
        key: "v1/infrastructure/manifests/year=2026/month=09/day=10/e9d904a6.json",
      },
    ],
  });
  expect(codes(result)).toEqual(["boundary_contradicted_by_history"]);
  expect(result.eligible_for_repeated_runs).toBe(false);
});

test("a key inside the declared folder says nothing", () => {
  const result = compileWorkflowEffectManifest({
    ...fixture("v1/infrastructure/manifests/"),
    observed_keys: [
      {
        step_id: "store_manifest",
        key: "v1/infrastructure/manifests/year=2026/month=09/day=10/e9d904a6.json",
      },
    ],
  });
  expect(result.manifest.issues).toEqual([]);
  expect(result.eligible_for_repeated_runs).toBe(true);
});

test("no history means silence, not suspicion — and the digest does not move", () => {
  const input = fixture("v1/latest/");
  const withoutEvidence = compileWorkflowEffectManifest(input);
  const withEmptyEvidence = compileWorkflowEffectManifest({ ...input, observed_keys: [] });
  const withOtherStep = compileWorkflowEffectManifest({
    ...input,
    observed_keys: [{ step_id: "a_different_step", key: "somewhere/else.json" }],
  });
  expect(withoutEvidence.manifest.issues).toEqual([]);
  expect(withEmptyEvidence.digest).toBe(withoutEvidence.digest);
  expect(withOtherStep.digest).toBe(withoutEvidence.digest);
  expect(withOtherStep.manifest.issues).toEqual([]);
});

test("the evidence never becomes part of what was approved", () => {
  const contradicted = compileWorkflowEffectManifest({
    ...fixture("v1/latest/"),
    observed_keys: [{ step_id: "store_manifest", key: "v1/elsewhere/a.json" }],
  });
  const serialised = JSON.stringify(contradicted.manifest);
  expect(serialised).not.toContain("v1/elsewhere/a.json");
  expect(serialised).not.toContain("observed_keys");
});

test("a step with no declared folder is not judged by its history", () => {
  const input = fixture("v1/latest/");
  const { storage: _dropped, ...unscoped } = input.bindings[0] as ResolvedEffectBinding;
  const result = compileWorkflowEffectManifest({
    ...input,
    bindings: [unscoped as ResolvedEffectBinding],
    observed_keys: [{ step_id: "store_manifest", key: "v1/elsewhere/a.json" }],
  });
  expect(codes(result)).not.toContain("boundary_contradicted_by_history");
});

test("the remedy names the trap instead of the shortcut", () => {
  const remedy = remedyFor("boundary_contradicted_by_history", "s3") ?? "";
  expect(remedy).toContain("Do NOT widen the folder");
  expect(remedy).toContain("do not remove the boundary");
  expect(remedy).toContain("not change what the step writes");
  expect(remedy).toContain("held in every preview");
  expect(remedyFor("boundary_contradicted_by_history", null)).toBe(remedy);
});
