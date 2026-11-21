import { expect, test } from "bun:test";
import { workflowJsonDigest } from "../../workflows/canonical-json.ts";
import { compileWorkflowEffectManifest } from "../../workflows/core/effect-manifest.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { approvedBoundary, localStepArgs } from "./step-args.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const CONNECTOR = "00000000-0000-4000-8000-000000000004";
const DEVICE = "66666666-6666-4666-8666-666666666666";
const D = (c: string) => c.repeat(64);

const shop = { origin: "https://shop.example", private: false, site_digest: D("c") };
const steps = [
  {
    id: "open",
    kind: "request",
    connector_id: CONNECTOR,
    method: "POST",
    path: "/browser.open",
    body: { url: "https://shop.example/orders" },
  },
  {
    id: "click",
    kind: "request",
    connector_id: CONNECTOR,
    method: "POST",
    path: "/browser.press",
    body: { action: "click", element: { role: "button", name: "Download" } },
  },
];

test("the boundary is read from a manifest compiled by the approval itself", () => {
  const definition = WorkflowDefSchema.parse({ name: "shop", steps });
  const binding = (index: number, device: Record<string, unknown>) => ({
    tenant_id: TENANT,
    step_id: steps[index]?.id as string,
    connector_id: CONNECTOR,
    driver: "local_browser" as const,
    environment: "prod" as const,
    request_digest: workflowJsonDigest(definition.steps[index]),
    target: `device:${DEVICE}/browser`,
    configuration_digest: D("d"),
    credential_binding_digest: null,
    rewrites_target: false,
    device: { device_id: DEVICE, capability: "browser" as const, ...device },
  });
  const compiled = compileWorkflowEffectManifest({
    tenant_id: TENANT,
    workflow_id: "00000000-0000-4000-8000-000000000002",
    workflow_version_id: "00000000-0000-4000-8000-000000000003",
    execution_environment: "prod",
    execution_options_digest: D("a"),
    definition: { name: "shop", steps },
    bindings: [binding(0, { sites: [shop] }), binding(1, {})],
  });
  expect(compiled.manifest.issues).toEqual([]);
  const stored = JSON.parse(JSON.stringify(compiled.manifest));
  const boundary = approvedBoundary(stored, "click", DEVICE, "browser");
  expect(boundary).toEqual({ device_id: DEVICE, capability: "browser", sites: [shop] });
  const planned = localStepArgs({
    kind: "browser.press",
    method: "POST",
    body: steps[1]?.body,
    boundary,
    partition: CONNECTOR,
  });
  expect(planned.ok).toBe(true);
  expect(approvedBoundary(stored, "open", DEVICE, "browser")).toEqual(boundary);
  expect(approvedBoundary(stored, "click", DEVICE, "files")).toBeNull();
});
