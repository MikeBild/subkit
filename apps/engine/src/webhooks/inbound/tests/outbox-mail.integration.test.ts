// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal runtime placeholder is the workflow contract.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { transactionalMailReceipts, workflowVersions } from "../../../db/schema/index.ts";
import { admitSystemWorkflowExecution } from "../../../execution/authority-admission.ts";
import { runExecution } from "../../../execution/engine.ts";
import { withSelfHostedDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { previewWorkflowAuthority } from "../../../workflows/execution-authorities.ts";
import { GMAIL_SEND_TARGET } from "../../../workflows/report-delivery-boundary.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const QUEUE = "https://worker.example.test/mail-outbox/next";
const SENDER = "workshops@example.test";
let ctx: InboundTestCtx;

async function author(maxPerDay: number, to = "input.scope.next_mail.data.recipient") {
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
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "Workshop mail outbox",
        execution_privacy: "sensitive",
        steps: [
          { id: "next_mail", kind: "request", method: "GET", url: QUEUE },
          {
            id: "compose",
            kind: "transform",
            language: "javascript",
            expression: `return { raw: sk.base64UrlEncodeUtf8('From: ${SENDER}\\r\\nTo: ' + ${to} + '\\r\\nSubject: Bestätigung\\r\\nMIME-Version: 1.0\\r\\nContent-Type: text/plain; charset=UTF-8\\r\\n\\r\\nHallo') };`,
          },
          {
            id: "send_email",
            kind: "request",
            method: "POST",
            url: GMAIL_SEND_TARGET,
            max_retries: 0,
            body: { raw: "${scope.compose.data.raw}" },
            outbox_delivery: {
              kind: "gmail_outbox",
              source_step_id: "next_mail",
              recipient_field: "recipient",
              item_id_field: "id",
              from: SENDER,
              content_type: "text/plain",
              max_body_bytes: 4096,
              max_per_day: maxPerDay,
            },
          },
        ],
      },
    })
    .where(and(eq(workflowVersions.tenant_id, ctx.tenantId), eq(workflowVersions.id, version.id)));
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: ctx.workflowId,
      workflow_version_id: version.id,
      execution_environment: "prod",
    },
    ctx.db,
  );
  expect(preview.manifest.issues).toEqual([]);
  await ctx.grantAuthority("prod", 10);
}

async function runWith(queued: { id: string; recipient: string }) {
  const sent: string[] = [];
  const fetcher = Object.assign(
    async (url: string | URL | Request) => {
      const target = String(url instanceof Request ? url.url : url);
      if (target.startsWith(QUEUE)) return Response.json(queued);
      sent.push(target);
      return Response.json({ id: "gmail-message" });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  const admitted = await admitSystemWorkflowExecution(
    {
      tenant_id: ctx.tenantId,
      workflow_id: ctx.workflowId,
      execution_environment: "prod",
      request_source: "scheduler",
      input: {},
    },
    ctx.db,
  );
  const result = await withSelfHostedDriverFetchForTests(fetcher, () =>
    runExecution({
      db: ctx.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: ctx.workflowId },
      input: {},
      options: {
        resume_authorized: true,
        existing_execution_id: admitted.execution_id,
        execution_mode: "prod",
        request_source: "scheduler",
      },
    }),
  );
  return { status: result.status, sent: sent.length };
}

async function receipts() {
  return ctx.db
    .select({ state: transactionalMailReceipts.state })
    .from(transactionalMailReceipts)
    .where(eq(transactionalMailReceipts.tenant_id, ctx.tenantId));
}

beforeEach(async () => {
  ctx = await createInboundCtx("outbox-mail");
});
afterEach(async () => {
  await ctx?.cleanup();
});

test("each queued message reaches its own recipient exactly once", async () => {
  await author(10);
  expect(await runWith({ id: "mail-1", recipient: "eins@example.test" })).toEqual({
    status: "succeeded",
    sent: 1,
  });
  expect(await runWith({ id: "mail-2", recipient: "zwei@example.test" })).toEqual({
    status: "succeeded",
    sent: 1,
  });
  expect((await runWith({ id: "mail-1", recipient: "eins@example.test" })).sent).toBe(0);
  expect((await receipts()).map((row) => row.state)).toEqual(["sent", "sent"]);
});

test("a message to anyone but the queued recipient never leaves", async () => {
  await author(10, "'fremd@example.test'");
  const outcome = await runWith({ id: "mail-1", recipient: "eins@example.test" });
  expect(outcome).toEqual({ status: "failed", sent: 0 });
  expect(await receipts()).toEqual([]);
});

test("the reviewed daily limit stops further messages", async () => {
  await author(1);
  expect((await runWith({ id: "mail-1", recipient: "eins@example.test" })).sent).toBe(1);
  expect(await runWith({ id: "mail-2", recipient: "zwei@example.test" })).toEqual({
    status: "failed",
    sent: 0,
  });
});
