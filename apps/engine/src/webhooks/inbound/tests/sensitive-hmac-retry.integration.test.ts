import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog, executions, workflowVersions } from "../../../db/schema/index.ts";
import { logRing } from "../../../observability/log-ring.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { handleInbound } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const secret = "synthetic-auth-delivery-signing-key";
const canary = "AUTH-ACTION-URL-PRIVATE-CANARY";
let ctx: InboundTestCtx;

beforeAll(async () => {
  ctx = await createInboundCtx("sensitive-hmac-retry");
  const [version] = await ctx.db
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, ctx.tenantId),
        eq(workflowVersions.workflow_id, ctx.workflowId),
      ),
    )
    .limit(1);
  if (!version) throw new Error("missing fixture workflow");
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: { ...(version.dag as Record<string, unknown>), execution_privacy: "sensitive" },
    })
    .where(and(eq(workflowVersions.tenant_id, ctx.tenantId), eq(workflowVersions.id, version.id)));
  await ctx.grantAuthority("prod", 1);
  await ctx.createBinding({
    slug: "sensitive-events",
    verifier: "hmac",
    secret,
    native_verifier_config: {
      hmac: {
        signature_header: "x-sender-signature",
        signature_prefix: "v1=",
        timestamp_header: "x-sender-timestamp",
        signed_payload: "v1:{timestamp}:{body}",
        id_header: "x-sender-message-id",
        id_field: "eventId",
        type_field: "eventType",
      },
    },
  });
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

function delivery(body: string, seconds: number) {
  const timestamp = String(Math.floor(getTestNow() / 1000) + seconds);
  return {
    slug: "sensitive-events",
    rawBody: body,
    now: Number(timestamp) * 1000,
    headers: {
      "x-sender-timestamp": timestamp,
      "x-sender-message-id": `unsigned-delivery-${seconds}`,
      "x-sender-signature": `v1=${createHmac("sha256", secret).update(`v1:${timestamp}:${body}`).digest("hex")}`,
    },
  };
}

test("sensitive HMAC retry uses signed event ID, reuses encrypted admission and rejects changed body", async () => {
  const body = JSON.stringify({
    eventId: "signed-event",
    eventType: "account.action",
    deliveryRequest: {
      recipient: "fixture@example.invalid",
      actionUrl: `https://example.invalid/action?token=${canary}`,
    },
  });
  const receive = (rawBody: string, seconds: number) =>
    handleInbound({ db: ctx.db, boss: ctx.boss }, delivery(rawBody, seconds));
  const send = spyOn(ctx.boss, "send").mockRejectedValueOnce(new Error("queue unavailable"));
  try {
    await expect(receive(body, 0)).rejects.toThrow("queue unavailable");
  } finally {
    send.mockRestore();
  }
  const before = await ctx.db
    .select()
    .from(executions)
    .where(eq(executions.tenant_id, ctx.tenantId));
  expect(before).toHaveLength(1);
  expect(JSON.stringify(before)).not.toContain(canary);
  expect(await receive(body, 1)).toMatchObject({ status: "ok", execution_id: before[0]?.id });
  expect(await receive(body, 2)).toMatchObject({ status: "deduped" });
  expect(await receive(body.replace(canary, "CHANGED-PRIVATE-CANARY"), 3)).toMatchObject({
    status: "denied",
    reason: "execution_boundary_mismatch",
  });
  const after = await ctx.db
    .select()
    .from(executions)
    .where(eq(executions.tenant_id, ctx.tenantId));
  expect(after).toHaveLength(1);
  const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, ctx.tenantId));
  expect(JSON.stringify({ after, audit, logs: logRing.tail({ limit: 500 }) })).not.toContain(
    canary,
  );
  expect(JSON.stringify({ after, audit, logs: logRing.tail({ limit: 500 }) })).not.toContain(
    "CHANGED-PRIVATE-CANARY",
  );
});
