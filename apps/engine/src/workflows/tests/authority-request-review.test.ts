import { expect, test } from "bun:test";
import { authorityRequestReview } from "../authority-request-review.ts";
import { RequestStepSchema } from "../types.ts";

test("masks GraphQL literal arguments, nested input secrets and indirectly named variable defaults", () => {
  const step = RequestStepSchema.parse({
    id: "graphql",
    kind: "request",
    method: "POST",
    url: "https://example.test",
    graphql: {
      query:
        'mutation Send($x: String = "secret-default") { send(recipient: "reviewed@example.test", password: $x, input: {api_key: "secret-literal", text: "Monthly report"}) { id } }',
      variables: { x: "secret-variable" },
    },
  });
  const original = JSON.stringify(step);
  const review = authorityRequestReview(step);
  expect(review.opaque_payload_omitted).toBe(false);
  for (const secret of ["secret-default", "secret-literal", "secret-variable"])
    expect(review.redacted_request_json).not.toContain(secret);
  expect(review.redacted_request_json).toContain("reviewed@example.test");
  expect(review.redacted_request_json).toContain("Monthly report");
  expect(JSON.stringify(step)).toBe(original);
});

test("does not expose an invalid GraphQL document as a raw fallback", () => {
  const step = RequestStepSchema.parse({
    id: "invalid",
    kind: "request",
    method: "POST",
    url: "https://example.test",
    graphql: { query: 'mutation { password: "do-not-display"' },
  });
  const review = authorityRequestReview(step);
  expect(review.opaque_payload_omitted).toBe(true);
  expect(review.redacted_request_json).not.toContain("do-not-display");
});

test("preserves business recipients and message content while masking credentials", () => {
  const step = RequestStepSchema.parse({
    id: "send",
    kind: "request",
    method: "POST",
    url: "https://user:password@example.test/send?recipient=one&recipient=two&api_key=private-query",
    headers: {
      "x-provider-custom": "opaque-private-header",
      authorization: "Bearer private-header",
    },
    body: {
      recipient: "reviewed@example.test",
      messages: [{ content: "Monthly report" }],
      password: "private-password",
      credential: { nested: "private-object" },
      cookie: ["private-cookie"],
    },
  });
  const before = JSON.stringify(step);
  const review = authorityRequestReview(step);
  const value = JSON.parse(review.redacted_request_json);
  expect(value.body.recipient).toBe("reviewed@example.test");
  expect(value.body.messages).toEqual([{ content: "Monthly report" }]);
  expect(value.url_query.recipient).toEqual(["one", "two"]);
  expect(value.header_names).toEqual(["authorization", "x-provider-custom"]);
  expect(value.header_values_omitted).toBe(true);
  for (const secret of [
    "private-query",
    "opaque-private-header",
    "private-header",
    "private-password",
    "private-object",
    "private-cookie",
    "user:password",
  ]) {
    expect(review.redacted_request_json).not.toContain(secret);
  }
  expect(review.request_review_truncated).toBe(false);
  expect(JSON.stringify(step)).toBe(before);
});

test("reports shortened payloads and opaque XML instead of presenting a complete review", () => {
  const step = RequestStepSchema.parse({
    id: "large",
    kind: "request",
    method: "POST",
    url: "https://example.test",
    body: { content: "a".repeat(20_000) },
  });
  expect(authorityRequestReview(step).request_review_truncated).toBe(true);
  expect(authorityRequestReview(step).redacted_request_json.length).toBe(16_000);
  const xml = RequestStepSchema.parse({
    id: "xml",
    kind: "request",
    method: "POST",
    url: "https://example.test",
    xml: { body: { password: "opaque-xml-secret" } },
  });
  expect(authorityRequestReview(xml).opaque_payload_omitted).toBe(true);
  expect(authorityRequestReview(xml).redacted_request_json).not.toContain("opaque-xml-secret");
});
