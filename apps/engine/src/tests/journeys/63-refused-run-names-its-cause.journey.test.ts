import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, executions } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
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

interface Outcome {
  cause_class: string | null;
  error_code: string | null;
  connector: { connector_id: string | null; reason: string } | null;
}
interface ListItem {
  id: string;
  failure: {
    cause_class: string | null;
    connector?: { connector_id: string | null; reason: string } | null;
  } | null;
}

async function detail(id: string): Promise<Outcome> {
  const res = await journeyFetch(ctx, `/v1/executions/${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { outcome: Outcome }).outcome;
}

async function listRow(id: string): Promise<ListItem | undefined> {
  const res = await journeyFetch(ctx, `/v1/executions?workflow_id=${workflowId}&limit=50`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: ListItem[] };
  return body.items.find((item) => item.id === id);
}

beforeAll(async () => {
  ctx = await createJourneyCtx("refused-run-cause");
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

describe("journey 63: a refused run names its cause", () => {
  test("AC1: a run refused for a connector to reconnect reads connector_unavailable", async () => {
    const res = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      headers: { "x-subkit-environment": "dev" },
      body: JSON.stringify({ source: "saved", workflow_id: workflowId }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { details?: { execution_id?: string } };
    const id = String(body.details?.execution_id);

    const outcome = await detail(id);
    expect(outcome.cause_class).toBe("connector_unavailable");
    expect(outcome.error_code).toBe("prepared_credential_unavailable");
    expect(outcome.connector).toEqual({ connector_id: devTwinId, reason: "needs_reauth" });

    const row = await listRow(id);
    expect(row?.failure?.cause_class).toBe("connector_unavailable");
    expect(row?.failure?.connector).toEqual({ connector_id: devTwinId, reason: "needs_reauth" });
  });

  test("AC2: a preparation closed because it never ran reads refused_before_start", async () => {
    const [row] = await ctx.db
      .insert(executions)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id: workflowId,
        workflow_version_id: versionId,
        source_kind: "saved",
        status: "failed",
        hold_writes: true,
        execution_mode: "dev",
        request_source: "api",
        finished_at: new Date(getTestNow()),
        failure: {
          step_id: null,
          error_code: "orphaned_preparation",
          error_message: "The preparation was refused before it started and never ran.",
        },
      })
      .returning({ id: executions.id });
    const id = row?.id ?? "";

    const outcome = await detail(id);
    expect(outcome.cause_class).toBe("refused_before_start");
    expect(outcome.connector).toBeNull();
    const listed = await listRow(id);
    expect(listed?.failure?.cause_class).toBe("refused_before_start");
  });

  test("AC3: a run that failed in its step keeps its own class", async () => {
    const wf = await seedWorkflow(ctx, {
      slug: "throws",
      name: "Throws",
      steps: [
        { kind: "transform", id: "boom", expression: `(() => { throw new Error("boom"); })()` },
      ],
    });
    const res = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wf.id, input: {} }),
    });
    const body = (await res.json()) as { execution_id?: string; id?: string };
    const id = String(body.execution_id ?? body.id);
    const outcome = await detail(id);
    expect(outcome.cause_class).not.toBe("connector_unavailable");
    expect(outcome.cause_class).not.toBe("refused_before_start");
    expect(outcome.connector).toBeNull();
  });
});
