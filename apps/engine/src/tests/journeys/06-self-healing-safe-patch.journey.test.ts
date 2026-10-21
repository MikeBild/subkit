import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import {
  auditLog,
  connectors,
  events,
  executionFixtures,
  executionSteps,
  executions,
  patchCandidates,
  schemaVersions,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { deriveShape, getLatestShape, recordSuccessShape } from "../../schema-versions/service.ts";
import { analyzeStepFailure } from "../../self-healing/drift-detector.ts";
import { runSelfHealingLoop } from "../../self-healing/service.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let connectorId = "";
let workflowId = "";
let executionId = "";
let stepId = "";
let fixtureId = "";
const endpointKey = "GET /users/1";

beforeAll(async () => {
  ctx = await createJourneyCtx("self-heal");

  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "legacy-api",
      display_name: "Legacy API",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
      config: {},
    })
    .returning();
  connectorId = connector!.id;

  const [wf] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenantId,
      slug: "fetch-user",
      name: "Fetch User",
      lifecycle: "active",
    })
    .returning();
  workflowId = wf!.id;

  const dag = {
    name: "Fetch User",
    steps: [
      {
        kind: "request",
        id: "req-1",
        method: "GET",
        connector_id: connectorId,
        path: "/users/1",
        data_selector: "$.data.id",
      },
    ],
  };
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({ tenant_id: ctx.tenantId, workflow_id: workflowId, version: 1, dag })
    .returning();
  await ctx.db
    .update(workflows)
    .set({ current_version_id: version!.id })
    .where(eq(workflows.id, workflowId));

  const [exec] = await ctx.db
    .insert(executions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: workflowId,
      workflow_version_id: version!.id,
      status: "failed",
      request_source: "api",
      execution_mode: "dev",
    })
    .returning();
  executionId = exec!.id;

  const [step] = await ctx.db
    .insert(executionSteps)
    .values({
      tenant_id: ctx.tenantId,
      execution_id: executionId,
      step_key: "req-1",
      step_index: 0,
      kind: "request",
      status: "failed",
      request_meta: { method: "GET", path: "/users/1", data_selector: "$.data.id" },
      error: {
        kind: "http",
        status: 404,
        body: { error: { code: "not_found", detail: "User not found" } },
      },
      output_preview: { data: { id: 1 } },
    })
    .returning();
  stepId = step!.id;

  await ctx.db.insert(schemaVersions).values({
    tenant_id: ctx.tenantId,
    connector_id: connectorId,
    endpoint_key: endpointKey,
    workflow_id: workflowId,
    step_id: "req-1",
    schema: {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: { id: { type: "number" }, name: { type: "string" } },
        },
      },
    },
  });

  const [fixture] = await ctx.db
    .insert(executionFixtures)
    .values({
      tenant_id: ctx.tenantId,
      connector_id: connectorId,
      endpoint_key: endpointKey,
      kind: "fixture",
      request: { method: "GET", path: "/users/1" },
      response: { data: { result: { id: 42, name: "Ada" } } },
    })
    .returning();
  fixtureId = fixture!.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey: self-healing safe patch", () => {
  test("AC1+AC2: loop proposes, classifies safe, dry-runs, auto-applies", async () => {
    const result = await runSelfHealingLoop(
      {
        tenant_id: ctx.tenantId,
        workflow_id: workflowId,
        execution_id: executionId,
        step_id: stepId,
        connector_id: connectorId,
        endpoint_key: endpointKey,
      },
      ctx.db,
    );
    expect(result.drift_detected).toBe(true);
    expect(result.classification).toBe("safe");
    expect(result.dry_run_passed).toBe(true);
    expect(result.auto_applied).toBe(true);
    expect(result.patch_candidate_id).toBeTruthy();

    const candidate = await ctx.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, result.patch_candidate_id!));
    expect(candidate[0]?.status).toBe("applied");
    expect(candidate[0]?.fixture_id).toBe(fixtureId);

    const versions = await ctx.db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, workflowId))
      .orderBy(desc(workflowVersions.version));
    expect(versions.length).toBeGreaterThanOrEqual(2);
  });

  test("AC3: audit log + outbox event record the lifecycle", async () => {
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_type, "patch_candidate")),
      );
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toContain("patch_candidate.proposed");
    expect(actions).toContain("patch_candidate.auto_applied");

    const evts = await ctx.db.select().from(events).where(eq(events.tenant_id, ctx.tenantId));
    expect(evts.some((e) => e.type === "patch.proposed")).toBe(true);
  });

  test("AC3b: patch-candidates REST surface surfaces the applied row", async () => {
    const listRes = await journeyFetch(ctx, "/v1/patch-candidates?status=applied");
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { items: Array<{ classification: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]?.classification).toBe("safe");
  });

  test("AC4: schema-version drift repair runs end-to-end", async () => {
    const endpoint = "GET /users/42";
    const [drift_connector] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id: ctx.tenantId,
        slug: "drift-api",
        display_name: "Drift API",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://drift.test",
        config: {},
      })
      .returning();
    const driftConnectorId = drift_connector!.id;

    const [drift_wf] = await ctx.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenantId,
        slug: "fetch-user-42",
        name: "Fetch User 42",
        lifecycle: "active",
      })
      .returning();
    const driftWorkflowId = drift_wf!.id;

    const [drift_version] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id: driftWorkflowId,
        version: 1,
        dag: {
          name: "Fetch User 42",
          steps: [
            {
              kind: "request",
              id: "req-1",
              method: "GET",
              connector_id: driftConnectorId,
              path: "/users/42",
              data_selector: "$.data.id",
            },
          ],
        },
      })
      .returning();
    await ctx.db
      .update(workflows)
      .set({ current_version_id: drift_version!.id })
      .where(eq(workflows.id, driftWorkflowId));

    const [drift_fixture] = await ctx.db
      .insert(executionFixtures)
      .values({
        tenant_id: ctx.tenantId,
        connector_id: driftConnectorId,
        endpoint_key: endpoint,
        kind: "fixture",
        request: { method: "GET", path: "/users/42" },
        response: { data: { result: { id: 42, full_name: "Grace" } } },
      })
      .returning();
    const driftFixtureId = drift_fixture!.id;

    const upstreamFlat = { data: { id: 1, name: "Ada" } };
    await recordSuccessShape(
      {
        tenant_id: ctx.tenantId,
        connector_id: driftConnectorId,
        endpoint_key: endpoint,
        workflow_id: driftWorkflowId,
        step_id: "drift-step",
        value: upstreamFlat,
      },
      ctx.db,
    );
    const shapeAfterFlat = await getLatestShape(
      {
        tenant_id: ctx.tenantId,
        connector_id: driftConnectorId,
        endpoint_key: endpoint,
      },
      ctx.db,
    );
    expect(shapeAfterFlat).not.toBeNull();
    expect(shapeAfterFlat).toEqual(deriveShape(upstreamFlat));

    const upstreamWrapped = { data: { result: { id: 1, full_name: "Ada" } } };
    const [drift_exec] = await ctx.db
      .insert(executions)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id: driftWorkflowId,
        workflow_version_id: drift_version!.id,
        status: "failed",
        request_source: "api",
        execution_mode: "dev",
      })
      .returning();
    const driftExecutionId = drift_exec!.id;

    const [drift_step] = await ctx.db
      .insert(executionSteps)
      .values({
        tenant_id: ctx.tenantId,
        execution_id: driftExecutionId,
        step_key: "req-1",
        step_index: 0,
        kind: "request",
        status: "failed",
        request_meta: {
          driver: "http",
          method: "GET",
          url: "/users/42",
          connector: {
            step_key: "drift-step",
            connector_id: "00000000-0000-0000-0000-000000000000",
            connector_slug: "stub",
            driver: "http",
            requested_environment: "dev",
            resolved_environment: "dev",
            auth_method: "none",
            base_url: null,
          },
          extras: { data_selector: "$.data.id" },
        },
        error: {
          kind: "jsonata_miss",
          expression: "data.id",
          missing_path: "data.id",
          captured_response: upstreamWrapped,
        },
        output_preview: upstreamWrapped,
      })
      .returning();
    const driftStepId = drift_step!.id;

    const schemaDiffSignal = analyzeStepFailure(
      {
        id: driftStepId,
        kind: "request",
        status: "failed",
        error: { kind: "unknown" },
        request_meta: {
          driver: "http",
          method: "GET",
          url: "/users/42",
          connector: {
            step_key: "drift-step",
            connector_id: "00000000-0000-0000-0000-000000000000",
            connector_slug: "stub",
            driver: "http",
            requested_environment: "dev",
            resolved_environment: "dev",
            auth_method: "none",
            base_url: null,
          },
          extras: { data_selector: "$.data.id" },
        },
        output_preview: { id: 1, name: "Ada", extra: "new-field" },
      },
      deriveShape({ id: 1, name: "Ada" }),
    );
    expect(schemaDiffSignal).not.toBeNull();
    expect(schemaDiffSignal?.kind).toBe("schema_diff");

    const loopResult = await runSelfHealingLoop(
      {
        tenant_id: ctx.tenantId,
        workflow_id: driftWorkflowId,
        execution_id: driftExecutionId,
        step_id: driftStepId,
        connector_id: driftConnectorId,
        endpoint_key: endpoint,
      },
      ctx.db,
    );
    expect(loopResult.drift_detected).toBe(true);
    expect(loopResult.classification).toBe("safe");
    expect(loopResult.auto_applied).toBe(true);
    expect(loopResult.patch_candidate_id).toBeTruthy();

    const driftCandidate = await ctx.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, loopResult.patch_candidate_id!));
    expect(driftCandidate[0]?.classification).toBe("safe");
    expect(driftCandidate[0]?.status).toBe("applied");
    expect(driftCandidate[0]?.fixture_id).toBe(driftFixtureId);

    await recordSuccessShape(
      {
        tenant_id: ctx.tenantId,
        connector_id: driftConnectorId,
        endpoint_key: endpoint,
        workflow_id: driftWorkflowId,
        step_id: "drift-step",
        value: upstreamWrapped,
      },
      ctx.db,
    );
    const settledShape = await getLatestShape(
      {
        tenant_id: ctx.tenantId,
        connector_id: driftConnectorId,
        endpoint_key: endpoint,
      },
      ctx.db,
    );
    const postSignal = analyzeStepFailure(
      {
        id: driftStepId,
        kind: "request",
        status: "succeeded",
        error: null,
        request_meta: {
          driver: "http",
          method: "GET",
          url: "/users/42",
          connector: {
            step_key: "drift-step",
            connector_id: "00000000-0000-0000-0000-000000000000",
            connector_slug: "stub",
            driver: "http",
            requested_environment: "dev",
            resolved_environment: "dev",
            auth_method: "none",
            base_url: null,
          },
          extras: { data_selector: "data.full_name" },
        },
        output_preview: upstreamWrapped,
      },
      settledShape ?? null,
    );
    expect(postSignal).toBeNull();

    const versions = await ctx.db
      .select()
      .from(schemaVersions)
      .where(
        and(
          eq(schemaVersions.tenant_id, ctx.tenantId),
          eq(schemaVersions.connector_id, driftConnectorId),
          eq(schemaVersions.endpoint_key, endpoint),
        ),
      )
      .orderBy(desc(schemaVersions.seen_at));
    expect(versions.length).toBe(2);
  });
});
