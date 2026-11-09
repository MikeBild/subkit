import { expect, test } from "bun:test";
import {
  OAUTH_AUTHORIZATION_URL_FIELD,
  OAuthApprovalInputSchema,
} from "./elicitation-constants.ts";

const input = {
  kind: "external_write" as const,
  question: "Authorize access?",
  summary: "Connect account",
  authorization_url: "https://example.test/authorize",
  redirect_uri: "myapp://return",
};
test("OAuth approvals publish the authorization URL field and preserve additional context", () => {
  expect(OAUTH_AUTHORIZATION_URL_FIELD).toBe("authorization_url");
  expect(OAuthApprovalInputSchema.parse({ ...input, context: "account" })).toEqual({
    ...input,
    context: "account",
  });
  for (const authorization_url of [
    "http://example.test/authorize",
    "HTTPS://example.test/authorize",
  ])
    expect(OAuthApprovalInputSchema.safeParse({ ...input, authorization_url }).success).toBe(true);
});
test("OAuth authorization accepts only an HTTP scheme at the start", () => {
  for (const authorization_url of [
    "ftp://example.test",
    "prefixhttps://example.test",
    "javascript:alert(1)",
  ]) {
    const parsed = OAuthApprovalInputSchema.safeParse({ ...input, authorization_url });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(
        parsed.error.issues.some(
          (issue) => issue.message === "authorization_url must be an http(s) URL",
        ),
      ).toBe(true);
  }
});
