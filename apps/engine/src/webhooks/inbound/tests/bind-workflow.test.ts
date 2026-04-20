// Inbound → workflow binding test. Confirms that a successful inbound
// hook enqueues an execution.run job with request_source=webhook and
// that an executions row is created.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { executions } from "../../../db/schema/index.ts";
import { handleInbound } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const SECRET = "whsec_bindtestaaaaaaaaaaaaaaaa";

let ctx: InboundTestCtx;

beforeAll(async () => {
  ctx = await createInboundCtx("bind");
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
  });
});
