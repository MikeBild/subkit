import { expect, test } from "bun:test";
import {
  type MaterializedRequest,
  preparedRequestProof,
  preparedRequestReview,
} from "../prepared-request.ts";
import type { RequestAuthoritySnapshot } from "../types.ts";

const snapshot: RequestAuthoritySnapshot = {
  step_id: "send",
  step_row_id: "preview-step",
  connector_id: null,
  requires_review: true,
  request_max_attempts: 5,
  principal_id: "operator",
  configuration_digest: "0".repeat(64),
  credential_id: null,
  credential_revision: null,
  connection_authority: null,
};
const request: MaterializedRequest = {
  method: "POST",
  url: "https://example.test/messages?channel=reviewed",
  headers: { Authorization: "Bearer private-test-token" },
  body: { recipient: "reviewed@example.test", message: "Private test message" },
};

test("proof is deterministic, tenant-bound, and contains no request secrets", () => {
  const proof = preparedRequestProof("tenant-a", snapshot, request, 5);
  expect(proof).not.toBeNull();
  expect(
    preparedRequestProof("tenant-a", { ...snapshot, step_row_id: "live-step" }, request, 5),
  ).toEqual(proof);
  expect(preparedRequestProof("tenant-b", snapshot, request, 5)).not.toEqual(proof);
  expect(JSON.stringify(proof)).not.toContain("private-test-token");
  expect(JSON.stringify(proof)).not.toContain("reviewed@example.test");
});

test("actual target, body, headers and authority changes invalidate the proof", () => {
  const proof = preparedRequestProof("tenant", snapshot, request, 5);
  for (const change of [
    { url: "https://other.test/messages?channel=reviewed" },
    { url: "https://example.test/messages?channel=other" },
    { method: "DELETE" },
    { headers: { Authorization: "Bearer different-token" } },
    { body: { recipient: "other@example.test", message: "Private test message" } },
  ])
    expect(preparedRequestProof("tenant", snapshot, { ...request, ...change }, 5)).not.toEqual(
      proof,
    );
  for (const change of [
    { principal_id: "other" },
    { configuration_digest: "a".repeat(64) },
    { credential_id: "other", credential_revision: 2 },
  ])
    expect(preparedRequestProof("tenant", { ...snapshot, ...change }, request, 5)).not.toEqual(
      proof,
    );
  expect(preparedRequestProof("tenant", snapshot, request, 4)).not.toEqual(proof);
});

test("only internally identified generated retry keys normalize, preserving page limits", () => {
  const generated = (key: string, page = 0): MaterializedRequest => ({
    ...request,
    headers: { ...request.headers, "Idempotency-Key": key },
    generated_idempotency: { key, page },
  });
  const proof = preparedRequestProof("tenant", snapshot, generated("preview:0"), 5);
  expect(preparedRequestProof("tenant", snapshot, generated("live:0"), 5)).toEqual(proof);
  expect(preparedRequestProof("tenant", snapshot, generated("live:1", 1), 5)).not.toEqual(proof);
  expect(
    preparedRequestProof(
      "tenant",
      snapshot,
      { ...generated("live:0"), generated_idempotency: { key: "mismatch", page: 0 } },
      5,
    ),
  ).toBeNull();
  expect(
    preparedRequestProof(
      "tenant",
      snapshot,
      { ...request, headers: { "Idempotency-Key": "user-key" } },
      5,
    ),
  ).not.toEqual(proof);
});

test("unsupported bodies and ambiguous case-duplicate headers fail closed", () => {
  expect(
    preparedRequestProof("tenant", snapshot, { ...request, unsupported_body: true }, 5),
  ).toBeNull();
  expect(
    preparedRequestProof(
      "tenant",
      snapshot,
      { ...request, headers: { Authorization: "one", authorization: "two" } },
      5,
    ),
  ).toBeNull();
});

test("request review retains recipient and content while masking keys and all header values", () => {
  const original = {
    ...request,
    url: "https://user:short-password@example.test/messages?recipient=reviewed%40example.test&token=short-query#private-fragment",
    headers: { Authorization: "short-auth", "X-Custom": "short-custom" },
    body: {
      recipient: "reviewed@example.test",
      subject: "Monthly report",
      password: "short-password",
      nested: [{ private_key: ["short-private"] }],
    },
  };
  const unchanged = JSON.stringify(original);
  const review = preparedRequestReview(original);
  expect(review?.url).toBe("https://example.test/messages");
  expect(review?.redacted_request_json).toContain("reviewed@example.test");
  expect(review?.redacted_request_json).toContain("Monthly report");
  expect(review?.redacted_request_json).toContain("X-Custom");
  for (const value of [
    "short-password",
    "short-query",
    "private-fragment",
    "short-auth",
    "short-custom",
    "short-private",
  ])
    expect(JSON.stringify(review)).not.toContain(value);
  expect(review?.request_review_truncated).toBe(false);
  expect(JSON.stringify(original)).toBe(unchanged);
});

test("serialized JSON is key-masked and opaque string bodies are explicitly omitted", () => {
  const review = preparedRequestReview({
    ...request,
    body: JSON.stringify({ recipient: "reviewed@example.test", password: "short-password" }),
  });
  expect(review?.redacted_request_json).toContain("reviewed@example.test");
  expect(review?.redacted_request_json).not.toContain("short-password");
  for (const body of [
    "password=short-password",
    "<script>short-password</script>",
    '"short-password"',
  ]) {
    const opaque = preparedRequestReview({ ...request, body });
    expect(opaque?.opaque_payload_omitted).toBe(true);
    expect(opaque?.redacted_request_json).not.toContain("short-password");
  }
});

test("large review projections are explicitly truncated and unknown materialization has no review", () => {
  const review = preparedRequestReview({
    ...request,
    body: { message: "ordinary words ".repeat(2000) },
  });
  expect(review?.request_review_truncated).toBe(true);
  expect(review?.redacted_request_json.length).toBe(16_000);
  expect(preparedRequestReview({ ...request, url: "not a URL" })).toBeNull();
  expect(preparedRequestReview({ ...request, unsupported_body: true })).toBeNull();
});
