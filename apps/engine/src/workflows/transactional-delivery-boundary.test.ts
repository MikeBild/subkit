import { describe, expect, test } from "bun:test";
import { workflowJsonDigest } from "./canonical-json.ts";
import { requestDigest } from "./core/request-protocol.ts";
import { compileWorkflowEffectManifest } from "./effect-manifest.ts";
import { GMAIL_SEND_TARGET } from "./report-delivery-boundary.ts";
import {
  assertTransactionalMessage,
  supportsTransactionalDelivery,
  TransactionalDeliveryBoundarySchema,
} from "./transactional-delivery-boundary.ts";
import { RequestStepSchema } from "./types.ts";

const id = "00000000-0000-4000-8000-000000000001";
const boundary = TransactionalDeliveryBoundarySchema.parse({
  kind: "gmail_transactional",
  webhook_id: id,
  event_type: "access.requested",
  event_type_input: "body.event",
  recipient_input: "body.applicant.address",
  request_id_input: "body.reference",
  from: "sender@example.test",
  content_type: "text/plain",
  max_body_bytes: 8192,
});
const event = {
  id,
  type: "access.requested",
  body: {
    event: "access.requested",
    reference: id,
    applicant: { address: "applicant@example.test" },
  },
};
function request(to = "applicant@example.test", extra = "", text = "Your requested access link") {
  return {
    method: "POST",
    url: GMAIL_SEND_TARGET,
    headers: {},
    body: {
      raw: Buffer.from(
        `From: sender@example.test\r\nTo: ${to}\r\nSubject: Requested access\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8${extra}\r\n\r\n${text}`,
      ).toString("base64url"),
    },
  };
}
describe("transactional mail is bound to the reviewed signed event", () => {
  test("HMAC signed-body identities use stable opaque receipts without changing Standard Webhooks", () => {
    const profile = { ...boundary, webhook_verifier: "hmac" as const };
    const input = {
      ...event,
      id: "signed-event-identity",
      body: { ...event.body, reference: "signed-event-identity" },
    };
    const first = assertTransactionalMessage(profile, input, request());
    expect(first.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(assertTransactionalMessage(profile, input, request()).request_id).toBe(first.request_id);
    expect(
      assertTransactionalMessage(
        profile,
        { ...input, id: "other-event", body: { ...input.body, reference: "other-event" } },
        request(),
      ).request_id,
    ).not.toBe(first.request_id);
    expect(() =>
      assertTransactionalMessage(profile, { ...input, id: "unsigned-header-id" }, request()),
    ).toThrow();
    expect(() => assertTransactionalMessage(boundary, input, request())).toThrow();
    expect(assertTransactionalMessage(boundary, event, request()).request_id).toBe(id);
  });
  test("Stripe-signed events use the signed event id as an opaque receipt", () => {
    const profile = {
      ...boundary,
      webhook_verifier: "stripe" as const,
      event_type: "checkout.session.completed",
      event_type_input: "body.type",
      request_id_input: "body.id",
      recipient_input: "body.data.object.customer_details.email",
    };
    const input = {
      id: "evt_signed_0001",
      type: "checkout.session.completed",
      body: {
        id: "evt_signed_0001",
        type: "checkout.session.completed",
        data: { object: { customer_details: { email: "applicant@example.test" } } },
      },
    };
    const first = assertTransactionalMessage(profile, input, request());
    expect(first.email).toBe("applicant@example.test");
    expect(first.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      assertTransactionalMessage({ ...profile, webhook_verifier: "hmac" }, input, request())
        .request_id,
    ).not.toBe(first.request_id);
    expect(() =>
      assertTransactionalMessage(profile, { ...input, id: "stripe-1790755200" }, request()),
    ).toThrow();
  });
  test("supports arbitrary reviewed field names and event types", () => {
    expect(assertTransactionalMessage(boundary, event, request())).toEqual({
      request_id: id,
      email: "applicant@example.test",
    });
  });
  test("does not trust an event header without its matching signed body type", () => {
    expect(() =>
      assertTransactionalMessage(
        boundary,
        { ...event, body: { ...event.body, event: "other" } },
        request(),
      ),
    ).toThrow();
  });
  test("rejects a different actual recipient", () => {
    expect(() =>
      assertTransactionalMessage(boundary, event, request("other@example.test")),
    ).toThrow();
  });
  test.each([
    "\r\nBcc: other@example.test",
    "\r\nCc: other@example.test",
    "\r\nTo: other@example.test",
  ])("rejects extra recipient header %s", (header) => {
    expect(() => assertTransactionalMessage(boundary, event, request(undefined, header))).toThrow();
  });
  test("rejects changed event identity, type, sender, endpoint and size", () => {
    expect(() =>
      assertTransactionalMessage(
        boundary,
        { ...event, id: "00000000-0000-4000-8000-000000000002" },
        request(),
      ),
    ).toThrow();
    expect(() =>
      assertTransactionalMessage(boundary, { ...event, type: "different" }, request()),
    ).toThrow();
    expect(() =>
      assertTransactionalMessage({ ...boundary, from: "other@example.test" }, event, request()),
    ).toThrow();
    expect(() =>
      assertTransactionalMessage(boundary, event, {
        ...request(),
        url: "https://other.example.test/send",
      }),
    ).toThrow();
    expect(() =>
      assertTransactionalMessage(boundary, event, request(undefined, "", "x".repeat(9000))),
    ).toThrow();
  });
  test("forbids prototype paths", () => {
    expect(
      TransactionalDeliveryBoundarySchema.safeParse({
        ...boundary,
        recipient_input: "body.__proto__.email",
      }).success,
    ).toBe(false);
  });
  test("requires explicit single-attempt Gmail write without iteration or static-report workaround", () => {
    const step = RequestStepSchema.parse({
      id: "deliver",
      kind: "request",
      method: "POST",
      url: GMAIL_SEND_TARGET,
      body: { raw: "${scope.mime.data.raw}" },
      max_retries: 0,
      transactional_delivery: boundary,
    });
    expect(supportsTransactionalDelivery(step, GMAIL_SEND_TARGET)).toBe(true);
    expect(supportsTransactionalDelivery({ ...step, max_retries: 1 }, GMAIL_SEND_TARGET)).toBe(
      false,
    );
    expect(
      supportsTransactionalDelivery({ ...step, for_each: "$input.recipients" }, GMAIL_SEND_TARGET),
    ).toBe(false);
    expect(
      supportsTransactionalDelivery(
        {
          ...step,
          report_delivery: {
            kind: "gmail_report",
            to: "other@example.test",
            from: boundary.from,
            content_type: "text/plain",
          },
        },
        GMAIL_SEND_TARGET,
      ),
    ).toBe(false);
  });
});

test("manifest requires a matching reviewed transactional profile and sensitive execution", () => {
  const step = RequestStepSchema.parse({
    id: "deliver",
    kind: "request",
    method: "POST",
    url: GMAIL_SEND_TARGET,
    body: { raw: "static" },
    max_retries: 0,
    transactional_delivery: boundary,
  });
  const binding = {
    tenant_id: id,
    step_id: step.id,
    connector_id: null,
    driver: "http",
    environment: "prod",
    request_digest: requestDigest(step),
    target: GMAIL_SEND_TARGET,
    configuration_digest: "a".repeat(64),
    credential_binding_digest: null,
    rewrites_target: false,
    transactional_delivery: boundary,
  };
  const input = {
    tenant_id: id,
    workflow_id: id,
    workflow_version_id: id,
    execution_environment: "prod",
    execution_options_digest: "b".repeat(64),
    definition: { name: "Requested mail", execution_privacy: "sensitive", steps: [step] },
    bindings: [binding],
  };
  expect(compileWorkflowEffectManifest(input).eligible_for_repeated_runs).toBe(true);
  expect(
    compileWorkflowEffectManifest({
      ...input,
      bindings: [{ ...binding, transactional_delivery: undefined }],
    }).eligible_for_repeated_runs,
  ).toBe(false);
  expect(
    compileWorkflowEffectManifest({
      ...input,
      bindings: [
        {
          ...binding,
          transactional_delivery: { ...boundary, recipient_input: "body.other.email" },
        },
      ],
    }).eligible_for_repeated_runs,
  ).toBe(false);
  expect(
    compileWorkflowEffectManifest({
      ...input,
      definition: { name: "Requested mail", steps: [step] },
    }).eligible_for_repeated_runs,
  ).toBe(false);
});
