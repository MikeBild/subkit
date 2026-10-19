import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  executionSteps,
  executions,
  transactionalMailReceipts,
  webhooksInbound,
  workflowVersions,
} from "../../../db/schema/index.ts";
import { admitSystemWorkflowExecution } from "../../../execution/authority-admission.ts";
import { runExecution } from "../../../execution/engine.ts";
import { recoverExecutionPayload } from "../../../execution/sensitive-payload.ts";
import { reserveTransactionalMail } from "../../../execution/transactional-mail.ts";
import { logRing } from "../../../observability/log-ring.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { withSelfHostedDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { previewWorkflowAuthority } from "../../../workflows/execution-authorities.ts";
import { GMAIL_SEND_TARGET } from "../../../workflows/report-delivery-boundary.ts";
import { handleInbound } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

let ctx: InboundTestCtx;
let hookId: string;
let versionId: string;
const secret = "isolated-body-bound-mail-signing-key";
const eventType = "account.delivery_requested";
const canary = "SYNTHETIC-AUTH-LINK-CANARY";
const config = {
  events: [eventType],
  hmac: {
    signature_header: "x-event-signature",
    signature_prefix: "v1=",
    signed_payload: "v1:{timestamp}:{body}",
    timestamp_header: "x-event-timestamp",
    tolerance_seconds: 300,
    id_header: "x-event-message-id",
    id_field: "eventId",
    type_field: "eventType",
  },
};
function mime(email: string) {
  return Buffer.from(
    `From: sender@example.test\r\nTo: ${email}\r\nSubject: Authentication\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nhttps://example.test/action?token=${canary}`,
  ).toString("base64url");
}
beforeAll(async () => {
  ctx = await createInboundCtx("hmac-transactional-mail");
  const hook = await ctx.createBinding({
    slug: "signed-mail-events",
    verifier: "hmac",
    secret,
    native_verifier_config: config,
  });
  hookId = hook.id;
  const [version] = await ctx.db
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, ctx.tenantId),
        eq(workflowVersions.workflow_id, ctx.workflowId),
      ),
    );
  if (!version) throw new Error("missing fixture version");
  versionId = version.id;
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "Signed requested mail",
        execution_privacy: "sensitive",
        output_transform: '{"accepted":true}',
        steps: [
          {
            id: "reply",
            kind: "request",
            method: "POST",
            url: GMAIL_SEND_TARGET,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: engine workflow placeholder
            body: { raw: "${input.body.mime}" },
            max_retries: 0,
            transactional_delivery: {
              kind: "gmail_transactional",
              webhook_verifier: "hmac",
              webhook_id: hookId,
              event_type: eventType,
              event_type_input: "body.eventType",
              recipient_input: "body.deliveryRequest.recipient",
              request_id_input: "body.eventId",
              from: "sender@example.test",
              content_type: "text/plain",
              max_body_bytes: 8192,
            },
          },
        ],
      },
    })
    .where(and(eq(workflowVersions.tenant_id, ctx.tenantId), eq(workflowVersions.id, versionId)));
  expect((await preview()).eligible_for_repeated_runs).toBe(true);
  await ctx.grantAuthority("prod", 20);
});
afterAll(async () => {
  await ctx?.cleanup();
});
function preview() {
  return previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: ctx.workflowId,
      workflow_version_id: versionId,
      execution_environment: "prod",
    },
    ctx.db,
  );
}
function event(id: string, email: string, mimeEmail = email, seconds = 0) {
  const timestamp = String(Math.floor(getTestNow() / 1000) + seconds);
  const body = JSON.stringify({
    eventId: id,
    eventType,
    deliveryRequest: { recipient: email, actionUrl: `https://example.test/action?token=${canary}` },
    mime: mime(mimeEmail),
  });
  return {
    slug: "signed-mail-events",
    rawBody: body,
    now: Number(timestamp) * 1000,
    headers: {
      "x-event-message-id": `unsigned-transport-${seconds}`,
      "x-event-timestamp": timestamp,
      "x-event-signature": `v1=${createHmac("sha256", secret).update(`v1:${timestamp}:${body}`).digest("hex")}`,
    },
  };
}
async function execute(id: string) {
  const [row] = await ctx.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, id)));
  if (!row) throw new Error("missing admitted execution");
  return runExecution({
    db: ctx.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id: ctx.workflowId },
    input: recoverExecutionPayload(row.input, ctx.tenantId, id),
    options: {
      resume_authorized: true,
      existing_execution_id: id,
      execution_mode: "prod",
      request_source: "webhook",
    },
  });
}
function transport(send: () => Response) {
  return Object.assign(async () => send(), { preconnect: () => {} }) as typeof fetch;
}
test("signed non-UUID events deliver to separate recipients once and retain no private payload", async () => {
  let sends = 0;
  await withSelfHostedDriverFetchForTests(
    transport(() => {
      sends++;
      return Response.json({ id: "provider-accepted" });
    }),
    async () => {
      for (const [id, email] of [
        ["signed-first-event", "first@example.test"],
        ["signed-second-event", "second@example.test"],
      ] as const) {
        const admitted = await handleInbound({ db: ctx.db, boss: ctx.boss }, event(id, email));
        expect(admitted.status).toBe("ok");
        if (admitted.status !== "ok") throw new Error("fixture admission failed");
        const result = await execute(admitted.execution_id);
        expect(result.status).toBe("succeeded");
        expect(result.output).toEqual({ accepted: true });
        expect(
          (await handleInbound({ db: ctx.db, boss: ctx.boss }, event(id, email, email, 1))).status,
        ).toBe("deduped");
        expect(
          (
            await handleInbound(
              { db: ctx.db, boss: ctx.boss },
              event(id, "changed@example.test", "changed@example.test", 2),
            )
          ).status,
        ).toBe("denied");
      }
    },
  );
  expect(sends).toBe(2);
  const receipts = await ctx.db
    .select()
    .from(transactionalMailReceipts)
    .where(eq(transactionalMailReceipts.tenant_id, ctx.tenantId));
  expect(receipts).toHaveLength(2);
  expect(receipts.every((row) => row.state === "sent")).toBe(true);
  const executionRows = await ctx.db
    .select()
    .from(executions)
    .where(eq(executions.tenant_id, ctx.tenantId));
  const steps = await ctx.db
    .select()
    .from(executionSteps)
    .where(eq(executionSteps.tenant_id, ctx.tenantId));
  const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, ctx.tenantId));
  expect(
    JSON.stringify({ receipts, executionRows, steps, audit, logs: logRing.tail({ limit: 500 }) }),
  ).not.toContain(canary);
});
test("signature, real recipient and internal provenance cannot be forged through event input", async () => {
  const valid = event("signed-invalid-signature", "first@example.test");
  expect(
    (
      await handleInbound(
        { db: ctx.db, boss: ctx.boss },
        { ...valid, headers: { ...valid.headers, "x-event-signature": "v1=invalid" } },
      )
    ).status,
  ).toBe("denied");
  const input = event("signed-recipient-mismatch", "first@example.test", "other@example.test");
  const mismatch = await handleInbound({ db: ctx.db, boss: ctx.boss }, input);
  if (mismatch.status !== "ok") throw new Error("fixture admission failed");
  const forged = await admitSystemWorkflowExecution(
    {
      tenant_id: ctx.tenantId,
      workflow_id: ctx.workflowId,
      execution_environment: "prod",
      request_source: "webhook",
      input: {
        id: "forged-event",
        type: eventType,
        body: JSON.parse(input.rawBody),
        verified_webhook_id: hookId,
      },
    },
    ctx.db,
  );
  let sends = 0;
  await withSelfHostedDriverFetchForTests(
    transport(() => {
      sends++;
      return Response.json({ id: "unexpected" });
    }),
    async () => {
      expect((await execute(mismatch.execution_id)).status).toBe("failed");
      expect((await execute(forged.execution_id)).status).toBe("failed");
    },
  );
  expect(sends).toBe(0);
});
test("header-only IDs, unsigned types, skipped checks, broad subscriptions and stale windows are unavailable", async () => {
  const { id_field: ignored, ...headerOnly } = config.hmac;
  for (const changed of [
    { ...config, hmac: headerOnly },
    { ...config, hmac: { ...config.hmac, type_header: "x-unsigned-type" } },
    { ...config, skip: true },
    { ...config, events: [eventType, "unrelated"] },
    { ...config, hmac: { ...config.hmac, tolerance_seconds: 301 } },
    { ...config, hmac: { ...config.hmac, signed_payload: "{body}" } },
    { ...config, hmac: { ...config.hmac, id_field: "other" } },
  ]) {
    await ctx.db
      .update(webhooksInbound)
      .set({ native_verifier_config: changed })
      .where(and(eq(webhooksInbound.tenant_id, ctx.tenantId), eq(webhooksInbound.id, hookId)));
    expect((await preview()).eligible_for_repeated_runs).toBe(false);
  }
  await ctx.db
    .update(webhooksInbound)
    .set({ native_verifier_config: config })
    .where(and(eq(webhooksInbound.tenant_id, ctx.tenantId), eq(webhooksInbound.id, hookId)));
  expect((await preview()).eligible_for_repeated_runs).toBe(true);
});
test("an uncertain provider acceptance reserves the signed identity before I/O and prevents resend", async () => {
  const input = event("signed-uncertain-event", "first@example.test");
  const admitted = await handleInbound({ db: ctx.db, boss: ctx.boss }, input);
  if (admitted.status !== "ok") throw new Error("fixture admission failed");
  let sends = 0;
  await withSelfHostedDriverFetchForTests(
    transport(() => {
      sends++;
      return Response.json({});
    }),
    async () => expect((await execute(admitted.execution_id)).status).toBe("failed"),
  );
  expect(sends).toBe(1);
  const [receipt] = await ctx.db
    .select()
    .from(transactionalMailReceipts)
    .where(
      and(
        eq(transactionalMailReceipts.tenant_id, ctx.tenantId),
        eq(transactionalMailReceipts.execution_id, admitted.execution_id),
      ),
    );
  expect(receipt?.state).toBe("delivery_unknown");
  if (!receipt) throw new Error("missing dispatch receipt");
  await expect(
    reserveTransactionalMail(ctx.db, {
      tenant_id: ctx.tenantId,
      workflow_id: ctx.workflowId,
      request_id: receipt.request_id,
      execution_id: "00000000-0000-4000-8000-000000000099",
      step_id: "reply",
    }),
  ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
  expect(
    (
      await handleInbound(
        { db: ctx.db, boss: ctx.boss },
        event("signed-uncertain-event", "first@example.test", "first@example.test", 1),
      )
    ).status,
  ).toBe("deduped");
});
