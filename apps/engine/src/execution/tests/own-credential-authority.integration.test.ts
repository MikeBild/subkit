import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors, workflowExecutionAuthorities } from "../../db/schema/index.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { admitAuthorizedWorkflowExecution } from "../authority-admission.ts";
import { callerFromPrincipal } from "../caller-context.ts";
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

let runs = 0;

const readerless = (): ResolvedPrincipal => ({
  provider: "local",
  kind: "user",
  id: "7a1c0e52-3b4d-4e6f-8a9b-0c1d2e3f4a5b",
  tenant_id: ctx.tenantId,
  roles: ["enduser"],
});

function exchangeStep(body: string) {
  return {
    id: "exchange",
    kind: "request",
    connector_id: ownId,
    method: "POST",
    path: "/token",
    side_effects: "write",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    boundary: { variables: {}, max_body_bytes: 4096, max_calls: 1 },
  };
}

function readStep(header: string) {
  return {
    id: "probe",
    kind: "request",
    connector_id: ownId,
    method: "GET",
    path: "/probe",
    headers: { "x-probe": header },
  };
}

async function authorizedRun(body: string, principal: ResolvedPrincipal | null = null) {
  runs += 1;
  const workflow = await createWorkflowRow(ctx, {
    name: `exchange ${runs}`,
    steps: [exchangeStep(body)],
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
    principal ? callerFromPrincipal(principal, ctx.tenantId) : null,
  );
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id: workflow.workflow_id },
    input: admitted.input,
    options: {
      existing_execution_id: admitted.execution_id,
      ...(principal ? { principal } : {}),
    },
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

  test("a caller without connector:read gets the own credential under the authority", async () => {
    bodies = [];
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    const result = await authorizedRun("secret=${cred.own-token.client_secret}", readerless());
    expect(result.status).toBe("succeeded");
    expect(bodies).toEqual([`secret=${OWN_SECRET}`]);
    expect(JSON.stringify(result)).not.toContain(OWN_SECRET);
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

describe("credential placeholders without an execution authority", () => {
  const unresolvedFor = (result: Awaited<ReturnType<typeof runExecution>>) => {
    const serialized = JSON.stringify(result);
    expect(result.status).toBe("failed");
    expect(serialized).toContain("placeholder_unresolved");
    expect(serialized).toContain("rbac_denied");
    expect(serialized).not.toContain(OWN_SECRET);
  };

  test("a step run of a caller without connector:read does not resolve the own credential", async () => {
    bodies = [];
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
      source: { kind: "step", step: readStep("${cred.own-token.client_secret}") },
      input: {},
      options: { principal: readerless(), hold_writes: true },
    });
    unresolvedFor(result);
    expect(bodies).toEqual([]);
  });

  test("a draft run of a caller without connector:read does not resolve the own credential", async () => {
    bodies = [];
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: {
        kind: "draft",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        definition: { name: "probe draft", steps: [readStep("${cred.own-token.client_secret}")] },
      },
      input: {},
      options: { principal: readerless() },
    });
    unresolvedFor(result);
    expect(bodies).toEqual([]);
  });

  test("a saved run without an authority does not resolve the own credential", async () => {
    bodies = [];
    runs += 1;
    const workflow = await createWorkflowRow(ctx, {
      name: `unauthorized ${runs}`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
      steps: [readStep("${cred.own-token.client_secret}")],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflow.workflow_id },
      input: {},
      options: { principal: readerless() },
    });
    unresolvedFor(result);
    expect(bodies).toEqual([]);
  });

  test("a held saved preparation does not resolve the own credential", async () => {
    bodies = [];
    runs += 1;
    const workflow = await createWorkflowRow(ctx, {
      name: `held ${runs}`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
      steps: [readStep("${cred.own-token.client_secret}")],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflow.workflow_id },
      input: {},
      options: { principal: readerless(), hold_writes: true },
    });
    unresolvedFor(result);
    expect(bodies).toEqual([]);
  });
});
