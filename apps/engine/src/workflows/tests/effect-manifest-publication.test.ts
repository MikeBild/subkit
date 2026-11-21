import { expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import {
  compileWorkflowEffectManifest,
  type ResolvedEffectBinding,
} from "../core/effect-manifest.ts";
import { WorkflowDefSchema } from "../types.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const workflow = "00000000-0000-4000-8000-000000000002";
const version = "00000000-0000-4000-8000-000000000003";
const connector = "00000000-0000-4000-8000-000000000004";
const origin = "https://content.example.test";
const item = "00000000-0000-4000-8000-000000000005";
const site = "00000000-0000-4000-8000-000000000006";

function fixture() {
  const definition = WorkflowDefSchema.parse({
    name: "Publish",
    steps: [
      {
        id: "update",
        kind: "request",
        connector_id: connector,
        method: "PUT",
        path: "/v1/content/${item.item_id}/revisions",
        body: "${item.markdown}",
        headers: { "Content-Type": "text/markdown" },
      },
      {
        id: "release",
        kind: "request",
        connector_id: connector,
        method: "POST",
        path: `/v1/sites/${site}/releases`,
        body: { revision_ids: "${scope.update.data.revision_ids}", reason: "Approved" },
        headers: { "Content-Type": "application/json" },
      },
    ],
  });
  const bindings: ResolvedEffectBinding[] = definition.steps.map((step) => ({
    tenant_id: tenant,
    step_id: step.id,
    connector_id: connector,
    driver: "http",
    environment: "dev",
    request_digest: workflowJsonDigest(step),
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    target:
      step.id === "update"
        ? `${origin}/v1/content/{approved-item}/revisions`
        : `${origin}/v1/sites/${site}/releases`,
    content_publication:
      step.id === "update"
        ? { kind: "content_revision", origin, item_ids: [item], max_bytes: 1000 }
        : {
            kind: "content_release",
            origin,
            site_id: site,
            reason: "Approved",
            sources: [{ step_id: "update", item_ids: [item] }],
          },
  }));
  return {
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "dev",
    execution_options_digest: "c".repeat(64),
    definition,
    bindings,
  };
}

test("a content release is bound to the same connector, origin and approved revision items", () => {
  const accepted = compileWorkflowEffectManifest(fixture());
  expect(accepted.manifest.issues).toEqual([]);
  expect(accepted.eligible_for_repeated_runs).toBe(true);
  for (const change of ["missing", "connector", "kind", "origin", "items"]) {
    const input = fixture();
    const producer = input.bindings[0]!;
    if (change === "missing") input.bindings.shift();
    if (change === "connector") producer.connector_id = tenant;
    if (change === "kind") producer.content_publication = input.bindings[1]!.content_publication;
    if (producer.content_publication?.kind === "content_revision") {
      if (change === "origin") producer.content_publication.origin = "https://other.example.test";
      if (change === "items") producer.content_publication.item_ids = [site];
    }
    const rejected = compileWorkflowEffectManifest(input);
    expect(rejected.eligible_for_repeated_runs).toBe(false);
    expect(rejected.manifest.issues).toContainEqual({
      step_id: "release",
      code: "binding_mismatch",
    });
  }
});
