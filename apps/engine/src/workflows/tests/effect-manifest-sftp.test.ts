import { expect, test } from "bun:test";
import { compileWorkflowEffectManifest } from "../core/effect-manifest.ts";
import { requestDigest } from "../core/request-protocol.ts";
import { WorkflowDefSchema } from "../types.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const connector = "00000000-0000-4000-8000-000000000004";

function compile(method: "LIST" | "GET" | "PUT" | "DELETE") {
  const definition = WorkflowDefSchema.parse({
    name: "sftp transfer",
    steps: [
      {
        kind: "request",
        protocol: "sftp",
        id: "transfer",
        connector_id: connector,
        method,
        sftp: { path: "reports/2026-11.csv" },
      },
    ],
  });
  return compileWorkflowEffectManifest({
    tenant_id: tenant,
    workflow_id: "00000000-0000-4000-8000-000000000002",
    workflow_version_id: "00000000-0000-4000-8000-000000000003",
    execution_environment: "prod",
    execution_options_digest: "c".repeat(64),
    definition,
    bindings: [
      {
        tenant_id: tenant,
        step_id: "transfer",
        connector_id: connector,
        driver: "sftp",
        environment: "prod",
        request_digest: requestDigest(definition.steps[0]),
        target: "sftp://files.example.com:22/inbox/reports/2026-11.csv",
        configuration_digest: "a".repeat(64),
        credential_binding_digest: "b".repeat(64),
        rewrites_target: false,
      },
    ],
  });
}

test("sftp LIST and GET are reads that may repeat without review", () => {
  for (const method of ["LIST", "GET"] as const) {
    const compiled = compile(method);
    expect(compiled.manifest.effects[0]?.effect).toBe("read");
    expect(compiled.eligible_for_repeated_runs).toBe(true);
  }
});

test("sftp PUT is a write", () => {
  expect(compile("PUT").manifest.effects[0]?.effect).toBe("write");
});

test("sftp DELETE is destructive and needs a reviewed run", () => {
  const compiled = compile("DELETE");
  expect(compiled.manifest.effects[0]?.effect).toBe("destructive");
  expect(compiled.manifest.issues.map((issue) => issue.code)).toContain("destructive_effect");
  expect(compiled.eligible_for_repeated_runs).toBe(false);
});
