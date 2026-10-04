import { describe, expect, test } from "bun:test";
import {
  OAUTH_AUTHORIZATION_URL_FIELD,
  OAuthApprovalInputSchema,
} from "../elicitation-constants.ts";

function producerOutput(): Record<string, unknown> {
  return {
    kind: "external_write",
    question: "Have you completed the authorization in your browser?",
    summary:
      "Authorize Acme in your browser:\nhttps://issuer.example.com/authorize?x=1\n\n" +
      "Add this redirect URI to the OAuth provider's allowlist first:\n" +
      "https://engine.example.com/v1/oauth/callback",
    [OAUTH_AUTHORIZATION_URL_FIELD]: "https://issuer.example.com/authorize?x=1",
    redirect_uri: "https://engine.example.com/v1/oauth/callback",
  };
}

describe("OAuthApprovalInputSchema — accepts the producer output", () => {
  test("the exact authenticate_oauth carrier shape parses", () => {
    const r = OAuthApprovalInputSchema.safeParse(producerOutput());
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.kind).toBe("external_write");
      expect(r.data[OAUTH_AUTHORIZATION_URL_FIELD]).toBe(
        "https://issuer.example.com/authorize?x=1",
      );
      expect(r.data.redirect_uri).toBe("https://engine.example.com/v1/oauth/callback");
    }
  });

  test("a missing authorization_url field is rejected", () => {
    const broken = producerOutput();
    delete broken[OAUTH_AUTHORIZATION_URL_FIELD];
    expect(OAuthApprovalInputSchema.safeParse(broken).success).toBe(false);
  });

  test("a non-URL authorization_url is rejected", () => {
    expect(
      OAuthApprovalInputSchema.safeParse({
        ...producerOutput(),
        [OAUTH_AUTHORIZATION_URL_FIELD]: "not-a-url",
      }).success,
    ).toBe(false);
  });

  test("a javascript: authorization_url is rejected", () => {
    const r = OAuthApprovalInputSchema.safeParse({
      ...producerOutput(),
      // eslint-disable-next-line no-script-url
      [OAUTH_AUTHORIZATION_URL_FIELD]: "javascript:alert(1)",
    });
    expect(r.success).toBe(false);
  });

  test("a data: authorization_url is rejected", () => {
    const r = OAuthApprovalInputSchema.safeParse({
      ...producerOutput(),
      [OAUTH_AUTHORIZATION_URL_FIELD]: "data:text/html,<script>alert(1)</script>",
    });
    expect(r.success).toBe(false);
  });
});

describe("OAuthApprovalInputSchema — rejects a non-OAuth ask_user_confirm shape", () => {
  test("a generic confirm payload fails the kind discriminator", () => {
    const generic = {
      kind: "tool_confirmation",
      question: "Save this workflow?",
      summary: "The workflow is ready to commit.",
    };
    const r = OAuthApprovalInputSchema.safeParse(generic);
    expect(r.success).toBe(false);
  });

  test("an external_write confirm with no authorization_url is still rejected", () => {
    const r = OAuthApprovalInputSchema.safeParse({
      kind: "external_write",
      question: "Proceed with the external write?",
      summary: "This will mutate an outside system.",
      redirect_uri: "https://engine.example.com/v1/oauth/callback",
    });
    expect(r.success).toBe(false);
  });
});
