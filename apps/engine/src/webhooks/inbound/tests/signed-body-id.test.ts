import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { stableWebhookPayload } from "../admission.ts";
import { HmacVerifierConfig, verifyHmac } from "../verifiers/hmac.ts";

const config = {
  signature_header: "x-sender-signature",
  signature_prefix: "v1=",
  timestamp_header: "x-sender-timestamp",
  signed_payload: "v1:{timestamp}:{body}",
  id_field: "eventId",
  type_field: "eventType",
};
const secret = "synthetic-signing-key";
const timestamp = String(Math.floor(getTestNow() / 1000));
function verify(body: string, signature?: string) {
  return verifyHmac({
    rawBody: body,
    secret,
    now: getTestNow(),
    config: { hmac: config },
    headers: {
      "x-sender-timestamp": timestamp,
      "x-sender-signature":
        signature ??
        `v1=${createHmac("sha256", secret).update(`v1:${timestamp}:${body}`).digest("hex")}`,
    },
  });
}

test("signed-body identity is read only after verifying exact raw bytes", () => {
  const body = '{ "eventId": "signed-id", "eventType": "account.action" }';
  expect(verify(body)).toEqual({
    ok: true,
    normalized: { id: "signed-id", timestamp: Number(timestamp), type: "account.action" },
  });
  const signature = `v1=${createHmac("sha256", secret).update(`v1:${timestamp}:${body}`).digest("hex")}`;
  expect(verify(body.replace("signed-id", "forged-id"), signature)).toEqual({
    ok: false,
    reason: "bad_signature",
  });
});

test("signed-body identity requires a nonempty bounded own top-level string", () => {
  for (const body of [
    "{}",
    '{"eventId":0}',
    '{"eventId":""}',
    JSON.stringify({ eventId: "x".repeat(513) }),
    "[]",
    '"not-an-object"',
  ]) {
    expect(verify(body)).toEqual({ ok: false, reason: "bad_hmac_event_id" });
  }
});

test("HMAC identity configuration must provide a source and cannot sign absent header identity", () => {
  expect(HmacVerifierConfig.safeParse({ signature_header: "x-sig" }).success).toBe(false);
  expect(HmacVerifierConfig.safeParse({ ...config, signed_payload: "{id}.{body}" }).success).toBe(
    false,
  );
  expect(HmacVerifierConfig.safeParse(config).success).toBe(true);
});

test("retry comparison ignores only configured volatile signing metadata and unsigned header identity", () => {
  const binding = {
    id: "hook",
    tenant_id: "tenant",
    workflow_id: "workflow",
    verifier: "hmac",
    native_verifier_config: { hmac: { ...config, id_header: "x-sender-message-id" } },
  };
  const payload = {
    id: "signed-id",
    timestamp: 1,
    type: "account.action",
    body: { eventId: "signed-id" },
    headers: {
      "x-sender-signature": "first",
      "x-sender-timestamp": "1",
      "x-sender-message-id": "first",
      "x-context": "unchanged",
    },
  };
  const retry = {
    ...payload,
    timestamp: 2,
    headers: {
      ...payload.headers,
      "x-sender-signature": "second",
      "x-sender-timestamp": "2",
      "x-sender-message-id": "second",
    },
  };
  expect(stableWebhookPayload(retry, binding)).toEqual(stableWebhookPayload(payload, binding));
  expect(stableWebhookPayload({ ...retry, body: { eventId: "changed" } }, binding)).not.toEqual(
    stableWebhookPayload(payload, binding),
  );
  expect(
    stableWebhookPayload(
      { ...retry, headers: { ...retry.headers, "x-context": "changed" } },
      binding,
    ),
  ).not.toEqual(stableWebhookPayload(payload, binding));
});
