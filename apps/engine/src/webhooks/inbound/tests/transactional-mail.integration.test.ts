import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  executions,
  transactionalMailReceipts,
  webhooksInbound,
  workflowVersions,
} from "../../../db/schema/index.ts";
import { admitSystemWorkflowExecution } from "../../../execution/authority-admission.ts";
import { runExecution } from "../../../execution/engine.ts";
import { recoverExecutionPayload } from "../../../execution/sensitive-payload.ts";
import {
  reserveTransactionalMail,
  settleTransactionalMail,
} from "../../../execution/transactional-mail.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { withSelfHostedDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { previewWorkflowAuthority } from "../../../workflows/execution-authorities.ts";
import { GMAIL_SEND_TARGET } from "../../../workflows/report-delivery-boundary.ts";
import { handleInbound } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

let ctx: InboundTestCtx;
let versionId: string;
let hookId: string;
const secret = "isolated-transactional-test-secret";
const eventType = "registration.requested";
const requestId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const raw = (email: string) =>
  Buffer.from(
    `From: sender@example.test\r\nTo: ${email}\r\nSubject: Access\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nYour requested link`,
  ).toString("base64url");
beforeEach(async () => {
  ctx = await createInboundCtx("transactional-mail");
  const hook = await ctx.createBinding({
    slug: "transactional-requests",
    verifier: "standard",
    secret,
    native_verifier_config: { events: [eventType] },
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
  if (!version) throw new Error("missing version");
  versionId = version.id;
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "Requested registration email",
        execution_privacy: "sensitive",
        steps: [
          {
            id: "reply",
            kind: "request",
            method: "POST",
            url: GMAIL_SEND_TARGET,
            body: { raw: "${input.body.raw}" },
            max_retries: 0,
            transactional_delivery: {
              kind: "gmail_transactional",
              webhook_id: hookId,
              event_type: eventType,
              event_type_input: "body.event",
              recipient_input: "body.contact.address",
              request_id_input: "body.reference",
              from: "sender@example.test",
              content_type: "text/plain",
              max_body_bytes: 8192,
            },
          },
        ],
      },
    })
    .where(and(eq(workflowVersions.tenant_id, ctx.tenantId), eq(workflowVersions.id, versionId)));
  expect(
    (
      await previewWorkflowAuthority(
        {
          tenant_id: ctx.tenantId,
          workflow_id: ctx.workflowId,
          workflow_version_id: versionId,
          execution_environment: "prod",
        },
        ctx.db,
      )
    ).eligible_for_repeated_runs,
  ).toBe(true);
  await ctx.grantAuthority("prod", 10);
});
afterEach(async () => {
  await ctx?.cleanup();
});

function event(id: string, email: string, mimeEmail = email) {
  const timestamp = String(Math.floor(getTestNow() / 1000));
  const body = JSON.stringify({
    event: eventType,
    reference: id,
    contact: { address: email },
    raw: raw(mimeEmail),
  });
  return {
    slug: "transactional-requests",
    rawBody: body,
    now: getTestNow(),
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-type": eventType,
      "webhook-signature": `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64")}`,
    },
  };
}
async function execute(id: string) {
  const [row] = await ctx.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, id)));
  if (!row) throw new Error("missing execution");
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
test("two signed applicants can receive one email each under the same approved profile", async () => {
  let sends = 0;
  const fetcher = Object.assign(
    async () => {
      sends++;
      return Response.json({ id: "gmail-message" });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  await withSelfHostedDriverFetchForTests(fetcher, async () => {
    for (const [id, email] of [
      [requestId, "first@example.test"],
      [secondId, "second@example.test"],
    ] as const) {
      const input = event(id, email);
      const accepted = await handleInbound({ db: ctx.db, boss: ctx.boss }, input);
      expect(accepted.status).toBe("ok");
      if (accepted.status !== "ok") throw new Error(JSON.stringify(accepted));
      const result = await execute(accepted.execution_id);
      if (result.status !== "succeeded") throw new Error(JSON.stringify(result));
      expect(result.status).toBe("succeeded");
      expect((await handleInbound({ db: ctx.db, boss: ctx.boss }, input)).status).toBe("deduped");
    }
  });
  expect(sends).toBe(2);
  const receipts = await ctx.db
    .select()
    .from(transactionalMailReceipts)
    .where(eq(transactionalMailReceipts.tenant_id, ctx.tenantId));
  expect(receipts.map((receipt) => receipt.state)).toEqual(["sent", "sent"]);
  const audits = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "transactional_mail.reserved")),
    );
  expect(audits).toHaveLength(2);
});
test("signature, changed duplicate input, actual recipient and revoked hook are enforced", async () => {
  const original = event(requestId, "first@example.test");
  expect((await handleInbound({ db: ctx.db, boss: ctx.boss }, original)).status).toBe("ok");
  expect(
    (
      await handleInbound(
        { db: ctx.db, boss: ctx.boss },
        { ...original, headers: { ...original.headers, "webhook-signature": "v1,invalid" } },
      )
    ).status,
  ).toBe("denied");
  expect(
    (await handleInbound({ db: ctx.db, boss: ctx.boss }, event(requestId, "changed@example.test")))
      .status,
  ).toBe("denied");
  const mismatch = await handleInbound(
    { db: ctx.db, boss: ctx.boss },
    event("00000000-0000-4000-8000-000000000003", "third@example.test", "other@example.test"),
  );
  if (mismatch.status !== "ok") throw new Error(JSON.stringify(mismatch));
  let sends = 0;
  const fetcher = Object.assign(
    async () => {
      sends++;
      return Response.json({ id: "unexpected" });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  await withSelfHostedDriverFetchForTests(fetcher, async () =>
    expect((await execute(mismatch.execution_id)).status).toBe("failed"),
  );
  expect(sends).toBe(0);
  const forgedId = "00000000-0000-4000-8000-000000000004";
  const forged = event(forgedId, "forged@example.test");
  const admitted = await admitSystemWorkflowExecution(
    {
      tenant_id: ctx.tenantId,
      workflow_id: ctx.workflowId,
      execution_environment: "prod",
      request_source: "webhook",
      input: {
        id: forgedId,
        type: eventType,
        body: JSON.parse(forged.rawBody),
        verified_webhook_id: hookId,
      },
    },
    ctx.db,
  );
  await withSelfHostedDriverFetchForTests(fetcher, async () =>
    expect((await execute(admitted.execution_id)).status).toBe("failed"),
  );
  expect(sends).toBe(0);
  await ctx.db
    .update(webhooksInbound)
    .set({ active: false })
    .where(and(eq(webhooksInbound.tenant_id, ctx.tenantId), eq(webhooksInbound.id, hookId)));
  expect(
    (
      await previewWorkflowAuthority(
        {
          tenant_id: ctx.tenantId,
          workflow_id: ctx.workflowId,
          workflow_version_id: versionId,
          execution_environment: "prod",
        },
        ctx.db,
      )
    ).eligible_for_repeated_runs,
  ).toBe(false);
});

test("parallel retries and new execution IDs cannot reserve a second mail after an uncertain attempt", async () => {
  const input = {
    tenant_id: ctx.tenantId,
    workflow_id: ctx.workflowId,
    request_id: "00000000-0000-4000-8000-000000000005",
    execution_id: requestId,
    step_id: "reply",
  };
  const results = await Promise.allSettled([
    reserveTransactionalMail(ctx.db, input),
    reserveTransactionalMail(ctx.db, { ...input, execution_id: secondId }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const [row] = await ctx.db
    .select()
    .from(transactionalMailReceipts)
    .where(
      and(
        eq(transactionalMailReceipts.tenant_id, ctx.tenantId),
        eq(transactionalMailReceipts.request_id, input.request_id),
      ),
    );
  if (!row) throw new Error("missing receipt");
  await settleTransactionalMail(
    ctx.db,
    { tenant_id: ctx.tenantId, execution_id: row.execution_id, step_id: "reply" },
    { status: "failed" },
  );
  await expect(
    reserveTransactionalMail(ctx.db, {
      ...input,
      execution_id: "00000000-0000-4000-8000-000000000006",
    }),
  ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
});

test("an ambiguous successful response remains unknown and cannot be sent again", async () => {
  const input = event(requestId, "first@example.test");
  const accepted = await handleInbound({ db: ctx.db, boss: ctx.boss }, input);
  if (accepted.status !== "ok") throw new Error(JSON.stringify(accepted));
  let attempts = 0;
  const fetcher = Object.assign(
    async () => {
      attempts++;
      return Response.json({});
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  await withSelfHostedDriverFetchForTests(fetcher, async () =>
    expect((await execute(accepted.execution_id)).status).toBe("failed"),
  );
  expect(attempts).toBe(1);
  const [receipt] = await ctx.db
    .select()
    .from(transactionalMailReceipts)
    .where(
      and(
        eq(transactionalMailReceipts.tenant_id, ctx.tenantId),
        eq(transactionalMailReceipts.request_id, requestId),
      ),
    );
  expect(receipt?.state).toBe("delivery_unknown");
  expect((await handleInbound({ db: ctx.db, boss: ctx.boss }, input)).status).toBe("deduped");
  await expect(
    reserveTransactionalMail(ctx.db, {
      tenant_id: ctx.tenantId,
      workflow_id: ctx.workflowId,
      request_id: requestId,
      execution_id: secondId,
      step_id: "reply",
    }),
  ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
});

test("unsigned and differently subscribed bindings cannot authorize transactional mail", async () => {
  for (const config of [
    { skip: true, events: [eventType] },
    { events: [eventType, "unrelated"] },
    { events: ["different"] },
  ]) {
    await ctx.db
      .update(webhooksInbound)
      .set({ native_verifier_config: config })
      .where(and(eq(webhooksInbound.tenant_id, ctx.tenantId), eq(webhooksInbound.id, hookId)));
    expect(
      (
        await previewWorkflowAuthority(
          {
            tenant_id: ctx.tenantId,
            workflow_id: ctx.workflowId,
            workflow_version_id: versionId,
            execution_environment: "prod",
          },
          ctx.db,
        )
      ).eligible_for_repeated_runs,
    ).toBe(false);
  }
});
