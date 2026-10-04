import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectors, executions } from "../../db/schema/index.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

let ctx: JourneyCtx;
let workflowId = "";
let versionId = "";
let devTwinId = "";
let refusedId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("run-unavailable-connector");
  const connector = {
    tenant_id: ctx.tenantId,
    slug: "gmail",
    display_name: "Gmail",
    driver: "http" as const,
    auth_type: "none" as const,
    base_url: "https://gmail.googleapis.com",
    config: {},
  };
  const [prod] = await ctx.db
    .insert(connectors)
    .values({ ...connector, environment: "prod" })
    .returning();
  const [devTwin] = await ctx.db
    .insert(connectors)
    .values({ ...connector, environment: "dev", needs_reauth: true })
    .returning();
  devTwinId = devTwin?.id ?? "";
  const workflow = await seedWorkflow(ctx, {
    slug: "send-digest",
    name: "Send digest",
    steps: [
      {
        id: "send",
        kind: "request",
        connector_id: prod?.id,
        method: "POST",
        path: "/gmail/v1/users/me/messages/send",
        body: { raw: "ZGlnZXN0" },
      },
    ],
  });
  workflowId = workflow.id;
  versionId = workflow.version_id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

function run(environment: "dev" | "prod") {
  return journeyFetch(ctx, "/v1/executions", {
    method: "POST",
    headers: { "x-subkit-environment": environment },
    body: JSON.stringify({ source: "saved", workflow_id: workflowId }),
  });
}

describe("journey: a run refuses a connector that must be reconnected", () => {
  test("AC1+AC2: development is refused with the connector named, nothing stays queued", async () => {
    const res = await run("dev");
    const body = (await res.json()) as {
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    };
    expect(res.status).toBe(409);
    expect(body.code).toBe("prepared_credential_unavailable");
    expect(body.message).toContain('"gmail"');
    expect(body.details).toMatchObject({
      step_id: "send",
      connector_id: devTwinId,
      connector_slug: "gmail",
      environment: "dev",
      reason: "needs_reauth",
    });
    const queued = await ctx.db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.workflow_id, workflowId), eq(executions.status, "queued")));
    expect(queued).toHaveLength(0);
    const [refused] = await ctx.db
      .select({ status: executions.status, failure: executions.failure })
      .from(executions)
      .where(eq(executions.id, String(body.details?.execution_id)));
    expect(refused?.status).toBe("failed");
    refusedId = String(body.details?.execution_id);
    expect(refused?.failure).toMatchObject({
      step_id: "send",
      error_code: "prepared_credential_unavailable",
    });
  });

  test("AC1: a rerun of the refused run is refused the same way", async () => {
    const res = await journeyFetch(ctx, `/v1/executions/${refusedId}/rerun`, {
      method: "POST",
      headers: { "x-subkit-environment": "dev" },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { code?: string; details?: Record<string, unknown> };
    expect(res.status).toBe(409);
    expect(body.code).toBe("prepared_credential_unavailable");
    expect(body.details).toMatchObject({ connector_id: devTwinId, reason: "needs_reauth" });
  });

  test("AC3: a preparation afterwards is not blocked by a stranded run", async () => {
    const res = await journeyFetch(
      ctx,
      `/v1/workflows/${workflowId}/versions/${versionId}/prepare-authority`,
      { method: "POST", body: JSON.stringify({ environment: "dev" }) },
    );
    const body = (await res.json()) as { reason?: string; code?: string };
    expect(body.reason).not.toBe("preparation_in_flight");
    expect(res.status).toBe(409);
    expect(body.code).toBe("prepared_credential_unavailable");
  });

  test("AC4: production is unchanged", async () => {
    const res = await run("prod");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string; hold_writes?: boolean };
    expect(body.hold_writes).toBe(true);
    expect(body.status).toBe("succeeded");
  });
});
