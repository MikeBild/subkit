import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { workflowSignals } from "../../db/schema/workflow_signals.ts";
import { createExecution } from "../../execution/state.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { runWithTestEnv } from "../../test-helpers/determinism/env.ts";
import { mintSignalToken } from "../../workflow-signals/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let sensitiveId: string;
let ordinaryId: string;
const payload = { private: "SENSITIVE-SIGNAL-CANARY" };
const env = { WAIT_FOR_EVENT_HMAC_SECRET: "test-only-signal-signing-secret" };

beforeAll(async () => {
  ctx = await createHttpTestServer("sensitive-signals");
  const workflow = await createWorkflowRow(ctx, {
    name: "Signal admission",
    slug: "signal-admission",
    steps: [{ id: "echo", kind: "transform", expression: "return input.input;" }],
  });
  const shared = {
    tenant_id: ctx.tenantId,
    workflow_id: workflow.workflow_id,
    workflow_version_id: workflow.version_id,
    source_kind: "saved" as const,
    source_ref: null,
    request_source: "api" as const,
    input: null,
  };
  ordinaryId = await createExecution(ctx.db, shared);
  sensitiveId = await createExecution(ctx.db, { ...shared, execution_privacy: "sensitive" });
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

for (const authentication of ["bearer", "signal-token"]) {
  test(`sensitive ${authentication} signals are refused without plaintext persistence`, async () => {
    await runWithTestEnv(env, async () => {
      const token =
        authentication === "signal-token"
          ? mintSignalToken({
              tenant_id: ctx.tenantId,
              execution_id: sensitiveId,
              event_name: "ready",
              expires_at: 4102444800,
            })
          : null;
      const response = await fetch(
        `${ctx.baseUrl}/v1/executions/${sensitiveId}/signals${token ? `?token=${encodeURIComponent(token)}` : ""}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ event: "ready", payload }),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "sensitive_execution_unsupported" });
      const signals = await ctx.db
        .select()
        .from(workflowSignals)
        .where(
          and(
            eq(workflowSignals.tenant_id, ctx.tenantId),
            eq(workflowSignals.execution_id, sensitiveId),
          ),
        );
      expect(signals).toHaveLength(0);
    });
  });
}

test("ordinary bearer signals retain their payload behavior", async () => {
  const response = await fetch(`${ctx.baseUrl}/v1/executions/${ordinaryId}/signals`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ event: "ready", payload: { value: "ordinary" } }),
  });
  expect(response.status).toBe(202);
  await response.body?.cancel();
  const signals = await ctx.db
    .select()
    .from(workflowSignals)
    .where(
      and(
        eq(workflowSignals.tenant_id, ctx.tenantId),
        eq(workflowSignals.execution_id, ordinaryId),
      ),
    );
  expect(signals).toHaveLength(1);
  expect(signals[0]?.payload).toEqual({ value: "ordinary" });
});
