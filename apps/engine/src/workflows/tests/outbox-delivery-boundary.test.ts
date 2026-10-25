// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal runtime placeholder is the workflow contract.
import { expect, test } from "bun:test";
import {
  assertOutboxMessage,
  OutboxDeliveryBoundarySchema,
  outboxReceiptId,
  outboxSourceFacts,
  outboxSourceStep,
  supportsOutboxDelivery,
} from "../outbox-delivery-boundary.ts";
import { GMAIL_SEND_TARGET } from "../report-delivery-boundary.ts";
import { WorkflowDefSchema } from "../types.ts";

const WORKFLOW = "11111111-1111-4111-8111-111111111111";
const boundary = OutboxDeliveryBoundarySchema.parse({
  kind: "gmail_outbox",
  source_step_id: "next_mail",
  recipient_field: "recipient",
  item_id_field: "id",
  from: "workshops@example.test",
  content_type: "text/plain",
  max_body_bytes: 4096,
  max_per_day: 50,
});
const mime = (to: string, from = boundary.from) => ({
  raw: Buffer.from(
    `From: ${from}\r\nTo: ${to}\r\nSubject: Bestätigung\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nHallo`,
  ).toString("base64url"),
});
const request = (body: unknown) => ({
  method: "POST",
  url: GMAIL_SEND_TARGET,
  headers: {},
  body: body as { raw: string },
});
const queued = (data: unknown, extra: Record<string, unknown> = {}) =>
  outboxSourceFacts(boundary, { data, error: null, status_code: 200, duration_ms: 3, ...extra });

test("the queued recipient may receive exactly this message, once per queued item", () => {
  const source = queued({ id: "mail-7", recipient: "teilnehmer@example.test" });
  const accepted = assertOutboxMessage(
    boundary,
    WORKFLOW,
    source,
    request(mime("teilnehmer@example.test")),
  );
  expect(accepted.email).toBe("teilnehmer@example.test");
  expect(accepted.request_id).toBe(outboxReceiptId(WORKFLOW, "next_mail", "mail-7"));
  expect(accepted.request_id).not.toBe(outboxReceiptId(WORKFLOW, "next_mail", "mail-8"));
});

test("a message to anyone but the queued recipient, or from another sender, is refused", () => {
  const source = queued({ id: "mail-7", recipient: "teilnehmer@example.test" });
  for (const body of [
    mime("fremd@example.test"),
    mime("teilnehmer@example.test", "other@example.test"),
  ])
    expect(() => assertOutboxMessage(boundary, WORKFLOW, source, request(body))).toThrow(
      "Outbox email differs",
    );
});

test("a failed, held or empty read gives no recipient to send to", () => {
  const body = request(mime("teilnehmer@example.test"));
  for (const source of [
    queued({ id: "mail-7", recipient: "teilnehmer@example.test" }, { status_code: 500 }),
    queued({ id: "mail-7", recipient: "teilnehmer@example.test" }, { held: true }),
    queued(null),
    queued({ recipient: "teilnehmer@example.test" }),
    undefined,
  ])
    expect(() => assertOutboxMessage(boundary, WORKFLOW, source, body)).toThrow();
});

test("the recipient may only come from an earlier fixed GET step", () => {
  const send = {
    id: "send_email",
    kind: "request",
    method: "POST",
    url: GMAIL_SEND_TARGET,
    max_retries: 0,
    outbox_delivery: boundary,
    body: { raw: "${scope.compose.data.raw}" },
  };
  const read = {
    id: "next_mail",
    kind: "request",
    method: "GET",
    url: "https://w.example.test/next",
  };
  const ordered = WorkflowDefSchema.parse({ name: "outbox", steps: [read, send] });
  const sendStep = ordered.steps[1];
  if (sendStep?.kind !== "request") throw new Error("send step missing");
  expect(supportsOutboxDelivery(sendStep, GMAIL_SEND_TARGET)).toBe(true);
  expect(outboxSourceStep(ordered, sendStep)?.id).toBe("next_mail");
  const reversed = WorkflowDefSchema.parse({ name: "outbox", steps: [send, read] });
  const late = reversed.steps[0];
  if (late?.kind !== "request") throw new Error("send step missing");
  expect(outboxSourceStep(reversed, late)).toBeNull();
  const writing = WorkflowDefSchema.parse({
    name: "outbox",
    steps: [{ ...read, method: "POST" }, send],
  });
  const afterWrite = writing.steps[1];
  if (afterWrite?.kind !== "request") throw new Error("send step missing");
  expect(outboxSourceStep(writing, afterWrite)).toBeNull();
  expect(
    supportsOutboxDelivery({ ...sendStep, for_each: "${scope.next_mail.data}" }, GMAIL_SEND_TARGET),
  ).toBe(false);
  expect(supportsOutboxDelivery({ ...sendStep, max_retries: 2 }, GMAIL_SEND_TARGET)).toBe(false);
});
