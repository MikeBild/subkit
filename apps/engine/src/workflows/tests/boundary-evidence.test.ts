// A folder a step's own history contradicts.
//
// Two production workflows were approved on one day with a storage boundary
// naming the wrong folder: a manifest writer declared its sibling's `v1/latest/`
// while writing `v1/infrastructure/manifests/…`, and a "latest" writer declared
// `v1/growth/` while writing `v1/latest/growth-weekly.json`. Neither could be
// caught at review — a write is HELD in every preview, so the declared folder
// is never exercised — and the approval dialog showed both beside boundaries
// that had been measured. The first scheduled run after each approval was
// refused, and repeated nightly.
//
// The runtime knew both real keys the whole time; they are on every successful
// step row. These pin the comparison, and — just as importantly — pin that it
// stays silent when it knows nothing. A check that reports what it cannot know
// is what makes an authoring model rewrite code that was right.

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

/** A storage step that declares a folder, as the authoring model writes it. */
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
              // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
              key: "${scope.build.data.manifest.key}",
              scope: { key_prefix, max_bytes: 1_000_000 },
            },
          },
        ],
      }),
    ),
  );
  const step = definition.steps[0];
  // Built by the compiler's own function, so the fixture cannot drift from the
  // shape the resolver actually produces.
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
  // The production shape: the neighbour's folder on a manifest writer.
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
  // The whole point. A step that has never run, or ran without recording a
  // key, must compile to exactly what it compiled before this check existed,
  // byte for byte: every live approval is bound to that digest.
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
  // It is a fact about the past, not a permission. If it entered the manifest,
  // every new run would move the digest and kill its own approval.
  const contradicted = compileWorkflowEffectManifest({
    ...fixture("v1/latest/"),
    observed_keys: [{ step_id: "store_manifest", key: "v1/elsewhere/a.json" }],
  });
  const serialised = JSON.stringify(contradicted.manifest);
  expect(serialised).not.toContain("v1/elsewhere/a.json");
  expect(serialised).not.toContain("observed_keys");
});

test("a step with no declared folder is not judged by its history", () => {
  // Without `s3.scope` there is nothing to contradict; the step is refused or
  // allowed by the rules that already applied to it.
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
  // The three wrong ways out, each refused by name — a remedy that leaves them
  // open is a remedy an authoring model will take.
  expect(remedy).toContain("Do NOT widen the folder");
  expect(remedy).toContain("do not remove the boundary");
  expect(remedy).toContain("not change what the step writes");
  // And why it can only be seen here.
  expect(remedy).toContain("held in every preview");
  // Reachable without a driver too: the issue is about the declaration, and a
  // driver-keyed registration would hide it from a caller that has none.
  expect(remedyFor("boundary_contradicted_by_history", null)).toBe(remedy);
});
