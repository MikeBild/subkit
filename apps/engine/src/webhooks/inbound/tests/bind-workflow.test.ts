// Inbound → workflow binding test. Confirms that a successful inbound
// hook enqueues an execution.run job with request_source=webhook and
// that an executions row is created.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  executionSteps,
  executions,
  workflows,
  workflowVersions,
} from "../../../db/schema/index.ts";
import { registerExecutionRunHandler } from "../../../queue/handlers/execution-run.ts";
import { waitFor } from "../../../test-helpers/determinism/wait.ts";
import { handleInbound } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const SECRET = "whsec_bindtestaaaaaaaaaaaaaaaa";

let ctx: InboundTestCtx;

beforeAll(async () => {
  ctx = await createInboundCtx("bind");
  const workflowRows = await ctx.db
    .select({ current_version_id: workflows.current_version_id })
    .from(workflows)
    .where(eq(workflows.id, ctx.workflowId))
    .limit(1);
  const currentVersionId = workflowRows[0]?.current_version_id;
  if (!currentVersionId) throw new Error("expected current workflow version");
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "wf-bind",
        version: 1,
        steps: [
          {
            id: "extract",
            kind: "transform",
            expression: "return input.input.body.invoice_id;",
            language: "javascript",
          },
        ],
      },
    })
    .where(eq(workflowVersions.id, currentVersionId));
  await ctx.grantAuthority();
  await registerExecutionRunHandler({ boss: ctx.boss, db: ctx.db });
  await ctx.createBinding({
    slug: "bind-trigger",
    verifier: "standard",
    secret: SECRET,
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("inbound: workflow binding", () => {
  test("valid delivery creates an executions row with request_source=webhook", async () => {
    const body = JSON.stringify({ invoice_id: "inv_123" });
    const webhookId = randomUUID(); // allow-random: legacy; review before changing
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v1,${createHmac("sha256", SECRET)
      .update(`${webhookId}.${ts}.${body}`, "utf8")
      .digest("base64")}`;
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "bind-trigger",
        rawBody: body,
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": String(ts),
          "webhook-signature": sig,
        },
      },
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    const rows = await ctx.db
      .select()
      .from(executions)
      .where(eq(executions.id, outcome.execution_id))
      .limit(1);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row?.request_source).toBe("webhook");
    expect(row?.workflow_id).toBe(ctx.workflowId);

    const finished = await waitFor(
      async () => {
        const latest = await ctx.db
          .select({ status: executions.status })
          .from(executions)
          .where(eq(executions.id, outcome.execution_id))
          .limit(1);
        const status = latest[0]?.status;
        return status === "succeeded" ? status : undefined;
      },
      { label: "webhook execution completion", tries: 120, sleepMs: 50 },
    );
    expect(finished).toBe("succeeded");

    const stepRows = await ctx.db
      .select({ output_preview: executionSteps.output_preview })
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, outcome.execution_id));
    expect(stepRows).toEqual([
      expect.objectContaining({
        output_preview: "inv_123",
      }),
    ]);
  });
});
