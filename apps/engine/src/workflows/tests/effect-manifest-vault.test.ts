import { describe, expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import { compileWorkflowEffectManifest } from "../core/effect-manifest.ts";
import { requestBoundary, requestBoundaryTarget } from "../request-boundary.ts";
import { type RequestStep, WorkflowDefSchema } from "../types.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const WORKFLOW = "00000000-0000-4000-8000-000000000002";
const VERSION = "00000000-0000-4000-8000-000000000003";
const CONNECTOR = "00000000-0000-4000-8000-000000000004";
const handle = (body: string) => `\${${body}}`;

function compile(headers: Record<string, string> | undefined) {
  const step = {
    id: "contacts",
    kind: "request",
    connector_id: CONNECTOR,
    method: "GET",
    path: "/contacts",
    boundary: { variables: {}, max_body_bytes: 0, max_calls: 1 },
    ...(headers ? { headers } : {}),
  };
  const steps = [step];
  const parsed = WorkflowDefSchema.parse({ name: "crm", steps }).steps[0] as RequestStep;
  const boundary = requestBoundary(parsed, "https://crm.example.test");
  if (!boundary) return null;
  return compileWorkflowEffectManifest({
    tenant_id: TENANT,
    workflow_id: WORKFLOW,
    workflow_version_id: VERSION,
    execution_environment: "prod",
    execution_options_digest: "a".repeat(64),
    definition: { name: "crm", steps },
    bindings: [
      {
        tenant_id: TENANT,
        step_id: "contacts",
        connector_id: CONNECTOR,
        driver: "http",
        environment: "prod",
        request_digest: workflowJsonDigest(parsed),
        target: requestBoundaryTarget(boundary),
        boundary,
        configuration_digest: "d".repeat(64),
        credential_binding_digest: null,
        rewrites_target: false,
      },
    ],
  });
}

function ok(headers: Record<string, string> | undefined) {
  const result = compile(headers);
  if (!result) throw new Error("the step has no request boundary");
  return result;
}

describe("vault handles in the effect manifest", () => {
  test("a step names the vault items it uses, by handle and never by value", () => {
    const result = ok({
      authorization: `Bearer ${handle("secret.crm-token")}`,
      "x-user": handle("secret.me.erp.username"),
    });
    expect(result.manifest.effects[0]?.secrets).toEqual(["crm-token", "me.erp"]);
    expect(result.manifest.issues).toEqual([]);
    expect(result.eligible_for_repeated_runs).toBe(true);
  });

  test("a step without handles carries no vault field, so older digests stay the same", () => {
    const result = ok({ accept: "application/json" });
    expect(result.manifest.effects[0]).not.toHaveProperty("secrets");
    expect(ok(undefined).manifest.effects[0]).not.toHaveProperty("secrets");
  });

  test("the handles are part of the approval digest", () => {
    expect(ok({ a: handle("secret.crm-token") }).digest).not.toBe(
      ok({ a: handle("secret.other") }).digest,
    );
  });

  test("any other runtime value in a header still leaves the step without a boundary", () => {
    expect(compile({ authorization: `Bearer ${handle("input.token")}` })).toBeNull();
    expect(
      compile({ authorization: `${handle("secret.crm-token")} ${handle("input.token")}` }),
    ).toBeNull();
  });
});
