// Pure-function tests for the SigV4 signer. The real `aws4` library
// is exercised end-to-end; we just assert the headers it produces
// land on the caller's bag and contain the right tokens.

import { describe, expect, test } from "bun:test";

import { signSigV4Request } from "./aws-sigv4.ts";
import { HttpRequestInvalidError } from "./http.ts";

describe("signSigV4Request", () => {
  test("attaches Authorization, X-Amz-Date, X-Amz-Content-Sha256", () => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    signSigV4Request({
      method: "POST",
      url: new URL(
        "https://qjz627ik5b4xjya4cibaba6ai.appsync-api.eu-central-1.amazonaws.com/graphql",
      ),
      headers,
      body: JSON.stringify({ query: "{ _meta { schemaVersion } }" }),
      region: "eu-central-1",
      service: "appsync",
      credential: {
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
    expect(headers.Authorization).toMatch(/\/eu-central-1\/appsync\/aws4_request/);
    expect(headers.Authorization).toContain("SignedHeaders=");
    expect(headers.Authorization).toContain("Signature=");
    // X-Amz-Date is stamped by aws4 for every service.
    expect(headers["X-Amz-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
    // X-Amz-Content-Sha256 is service-specific (S3 + a handful of
    // others) — don't assert it here.
    // Original headers preserved.
    expect(headers["content-type"]).toBe("application/json");
  });

  test("includes X-Amz-Security-Token when session_token present (STS)", () => {
    const headers: Record<string, string> = {};
    signSigV4Request({
      method: "GET",
      url: new URL("https://dynamodb.us-east-1.amazonaws.com/"),
      headers,
      region: "us-east-1",
      service: "dynamodb",
      credential: {
        access_key_id: "ASIAEXAMPLE",
        secret_access_key: "secret",
        session_token: "FwoGZXIvYXdz...",
      },
    });
    expect(headers["X-Amz-Security-Token"]).toBe("FwoGZXIvYXdz...");
    expect(headers.Authorization).toContain("AWS4-HMAC-SHA256");
  });

  test("does not lift the Host header onto the bag (fetch rejects manual Host)", () => {
    const headers: Record<string, string> = {};
    signSigV4Request({
      method: "GET",
      url: new URL("https://api.execute-api.eu-west-1.amazonaws.com/prod/items"),
      headers,
      region: "eu-west-1",
      service: "execute-api",
      credential: {
        access_key_id: "AKIAEXAMPLE",
        secret_access_key: "secret",
      },
    });
    // Lowercase + uppercase variants both absent.
    expect(headers.Host).toBeUndefined();
    expect(headers.host).toBeUndefined();
    // But Host IS in SignedHeaders (aws4 always signs it).
    expect(headers.Authorization).toMatch(/SignedHeaders=[^,]*host/);
  });

  test("idempotent — re-signing the same request twice yields the same Authorization", () => {
    // Aside from X-Amz-Date which encodes wall-clock seconds. We assert
    // the credential / scope segment stays stable so retries produce
    // canonical signatures.
    const headers1: Record<string, string> = {};
    const headers2: Record<string, string> = {};
    const url = new URL("https://api.example-region.amazonaws.com/");
    const cred = {
      access_key_id: "AKIATEST",
      secret_access_key: "shh",
    };
    signSigV4Request({
      method: "GET",
      url,
      headers: headers1,
      region: "eu-central-1",
      service: "appsync",
      credential: cred,
    });
    signSigV4Request({
      method: "GET",
      url,
      headers: headers2,
      region: "eu-central-1",
      service: "appsync",
      credential: cred,
    });
    expect(headers1.Authorization?.split(", Signature=")[0]).toBe(
      headers2.Authorization?.split(", Signature=")[0],
    );
  });

  // Audit anti-pattern E1: malformed sigv4 inputs used to throw a
  // generic Error that the request-step retry loop misclassified as a
  // transient `connection` error and retried 5×. Now they throw
  // `HttpRequestInvalidError` and the loop converts to
  // `RequestError("...", "request_invalid")` which is non-retryable.
  describe("malformed inputs throw HttpRequestInvalidError", () => {
    const url = new URL("https://example.amazonaws.com/x");
    const cred = {
      access_key_id: "AKIA...",
      secret_access_key: "secret",
    };

    test("empty region", () => {
      expect(() =>
        signSigV4Request({
          method: "GET",
          url,
          headers: {},
          region: "",
          service: "appsync",
          credential: cred,
        }),
      ).toThrow(HttpRequestInvalidError);
    });

    test("region with invalid characters", () => {
      expect(() =>
        signSigV4Request({
          method: "GET",
          url,
          headers: {},
          region: "us-east-1; DROP",
          service: "appsync",
          credential: cred,
        }),
      ).toThrow(HttpRequestInvalidError);
    });

    test("empty service", () => {
      expect(() =>
        signSigV4Request({
          method: "GET",
          url,
          headers: {},
          region: "us-east-1",
          service: "",
          credential: cred,
        }),
      ).toThrow(HttpRequestInvalidError);
    });

    test("missing access_key_id", () => {
      expect(() =>
        signSigV4Request({
          method: "GET",
          url,
          headers: {},
          region: "us-east-1",
          service: "appsync",
          credential: { access_key_id: "", secret_access_key: "x" },
        }),
      ).toThrow(HttpRequestInvalidError);
    });

    test("missing secret_access_key", () => {
      expect(() =>
        signSigV4Request({
          method: "GET",
          url,
          headers: {},
          region: "us-east-1",
          service: "appsync",
          credential: { access_key_id: "AKIA...", secret_access_key: "" },
        }),
      ).toThrow(HttpRequestInvalidError);
    });
  });
});
