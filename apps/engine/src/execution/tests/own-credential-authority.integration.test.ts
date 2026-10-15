import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors, workflowExecutionAuthorities } from "../../db/schema/index.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { admitAuthorizedWorkflowExecution } from "../authority-admission.ts";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

const OWN_SECRET = "fixture-authority-own-secret-2b7f";
const OTHER_SECRET = "fixture-authority-other-secret-8c3d";

let ctx: EngineTestCtx;
let host: MockServer;
let bodies: string[] = [];
let ownId: string;

async function seed(slug: string, secret: string) {
  const [row] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug,
      display_name: slug,
      driver: "http",
      auth_type: "header",
      environment: "dev",
      base_url: host.baseUrl,
    })
    .returning();
  if (!row) throw new Error("connector fixture missing");
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: row.id,
      environment: "dev",
      mode: "header",
      actor_id: null,
      value: { mode: "header", headers: { client_secret: secret } },
    },
    ctx.testDb.db,
  );
  return row.id;
}

async function authorizedRun(body: string) {
  const workflow = await createWorkflowRow(ctx, {
    name: `exchange ${bodies.length}-${body.length}`,
    steps: [
      {
        id: "exchange",
        kind: "request",
        connector_id: ownId,
        method: "POST",
        path: "/token",
        side_effects: "write",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        boundary: { variables: {}, max_body_bytes: 4096, max_calls: 1 },
      },
    ],
  });
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: workflow.workflow_id,
      workflow_version_id: workflow.version_id,
      execution_environment: "dev",
    },
    ctx.testDb.db,
  );
  const now = await databaseNow(ctx.testDb.db);
  await ctx.testDb.db.insert(workflowExecutionAuthorities).values({
    tenant_id: ctx.tenantId,
    workflow_id: workflow.workflow_id,
    workflow_version_id: workflow.version_id,
    effect_manifest_digest: preview.digest,
    effect_manifest: { ...preview.manifest },
    target_constraints: {
      targets: preview.manifest.effects.flatMap((effect) => (effect.target ? [effect.target] : [])),
    },
    execution_environment: "dev",
    valid_from: new Date(now.getTime() - 60_000),
    created_by: "00000000-0000-4000-8000-000000000001",
  });
  const admitted = await admitAuthorizedWorkflowExecution(
    {
      tenant_id: ctx.tenantId,
      workflow_id: workflow.workflow_id,
      execution_environment: "dev",
      request_source: "api",
      input: {},
    },
    ctx.testDb.db,
  );
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id: workflow.workflow_id },
    input: admitted.input,
    options: { existing_execution_id: admitted.execution_id },
  });
}

beforeAll(async () => {
  ctx = await createEngineCtx("own-credential-authority");
  host = await createMockServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    jsonResponse(res, 200, { ok: true });
  });
  ownId = await seed("own-token", OWN_SECRET);
  await seed("other-token", OTHER_SECRET);
});

afterAll(async () => {
  await host?.close();
  if (ctx) await ctx.cleanup();
});

describe("credential placeholders under an execution authority", () => {
  test("the step's own connector credential is inside the approved boundary", async () => {
    bodies = [];
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    const result = await authorizedRun("secret=${cred.own-token.client_secret}");
    expect(result.status).toBe("succeeded");
    expect(bodies).toEqual([`secret=${OWN_SECRET}`]);
  });

  test("another connector's credential is outside it and nothing is sent", async () => {
    bodies = [];
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    const result = await authorizedRun("secret=${cred.other-token.client_secret}");
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).toContain("execution_authority_changed");
    expect(bodies).toEqual([]);
  });
});
