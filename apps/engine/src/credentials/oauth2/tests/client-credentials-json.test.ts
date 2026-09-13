// Unit tests for the client_credentials_json grant — a generalised
// JSON-body exchange where:
//   - the request is a JSON POST with configurable body field mapping
//   - the response may be a bare quoted token string ("raw") or a
//     standard JSON envelope with an "access_token" key ("json")
//   - when the server returns no expires_in the caller supplies a
//     default TTL via token_response_ttl_ms
//
// These tests mock the endpoint through the driver-fetch seam so no
// live server is required.

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { withDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { runClientCredentialsJsonGrant } from "../client.ts";

let fetchSpy: ReturnType<typeof mock<typeof fetch>>;

beforeEach(() => {
  fetchSpy = mock<typeof fetch>();
});

// Driver-fetch seam: the oauth2 client reads getDriverFetch(), not
// globalThis — run each body under the seam's explicit wrapper (the
// override must scope the body itself; an enterWith-from-beforeEach
// binding did not propagate into test bodies under bun).
function seamTest(name: string, body: () => Promise<void>) {
  test(name, () => withDriverFetchForTests(fetchSpy as unknown as typeof fetch, body));
}

describe("runClientCredentialsJsonGrant — raw response (Xray-style)", () => {
  seamTest("POSTs JSON body with mapped credential fields", async () => {
    fetchSpy.mockResolvedValue(
      new Response('"eyJraWQiOiJ0ZXN0IiwidHlwIjoiSldUIn0.payload.sig"', {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    await runClientCredentialsJsonGrant({
      token_endpoint: "https://example.test/api/v2/authenticate",
      body_mapping: { client_id: "cid-001", client_secret: "s3cr3t" },
      response_format: "raw",
      token_response_ttl_ms: 86_400_000,
    });

    const call = fetchSpy.mock.calls[0];
    expect(call?.[0]).toBe("https://example.test/api/v2/authenticate");
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body.client_id).toBe("cid-001");
    expect(body.client_secret).toBe("s3cr3t");
  });

  seamTest("strips surrounding quotes and whitespace from raw quoted-JWT response", async () => {
    // Xray's authenticate endpoint returns a response body that IS the JWT
    // wrapped in double-quotes, e.g. "eyJra…sig"  (with a possible trailing
    // newline). We must strip the quotes and whitespace.
    fetchSpy.mockResolvedValue(
      new Response('"eyJraWQiOiJ0ZXN0Ii5wYXlsb2FkLnNpZw=="\n', {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const bundle = await runClientCredentialsJsonGrant({
      token_endpoint: "https://example.test/api/v2/authenticate",
      body_mapping: { client_id: "cid", client_secret: "sec" },
      response_format: "raw",
      token_response_ttl_ms: 86_400_000,
    });

    expect(bundle.access_token).toBe("eyJraWQiOiJ0ZXN0Ii5wYXlsb2FkLnNpZw==");
    expect(bundle.token_type).toBe("Bearer");
    expect(bundle.refresh_token).toBeNull();
    expect(bundle.scope).toBeNull();
  });

  seamTest("applies token_response_ttl_ms as expires_at when response has no expiry", async () => {
    fetchSpy.mockResolvedValue(
      new Response('"tok"', {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const bundle = await runClientCredentialsJsonGrant({
      token_endpoint: "https://example.test/api/v2/authenticate",
      body_mapping: { client_id: "cid", client_secret: "sec" },
      response_format: "raw",
      token_response_ttl_ms: 86_400_000,
    });

    expect(bundle.expires_at).toBeInstanceOf(Date);
    // expires_at should be roughly now + 24h (within a 5s tolerance).
    const expectedMs = Date.now() + 86_400_000; // allow-wall-clock: tolerance-window assertion against the production clock (oauth2/client.ts computes expiry via Date.now)
    expect(Math.abs(bundle.expires_at!.getTime() - expectedMs)).toBeLessThan(5_000);
  });

  seamTest("throws a typed error on non-2xx response", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    let caught: Error | null = null;
    try {
      await runClientCredentialsJsonGrant({
        token_endpoint: "https://example.test/api/v2/authenticate",
        body_mapping: { client_id: "bad", client_secret: "bad" },
        response_format: "raw",
        token_response_ttl_ms: 86_400_000,
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain("401");
  });
});

describe("runClientCredentialsJsonGrant — json response", () => {
  seamTest("extracts access_token from JSON envelope", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "json-tok-abc",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const bundle = await runClientCredentialsJsonGrant({
      token_endpoint: "https://example.test/token",
      body_mapping: { client_id: "cid", client_secret: "sec" },
      response_format: "json",
      token_response_ttl_ms: 86_400_000,
    });

    expect(bundle.access_token).toBe("json-tok-abc");
    expect(bundle.token_type).toBe("Bearer");
    // expires_at from expires_in=3600 should be ~1h from now.
    expect(bundle.expires_at).toBeInstanceOf(Date);
    const expectedMs = Date.now() + 3600 * 1000; // allow-wall-clock: tolerance-window assertion against the production clock (oauth2/client.ts computes expiry via Date.now)
    expect(Math.abs(bundle.expires_at!.getTime() - expectedMs)).toBeLessThan(5_000);
  });

  seamTest("falls back to token_response_ttl_ms when JSON envelope has no expires_in", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "tok-no-expiry" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const bundle = await runClientCredentialsJsonGrant({
      token_endpoint: "https://example.test/token",
      body_mapping: { client_id: "cid", client_secret: "sec" },
      response_format: "json",
      token_response_ttl_ms: 7_200_000,
    });

    expect(bundle.access_token).toBe("tok-no-expiry");
    const expectedMs = Date.now() + 7_200_000; // allow-wall-clock: tolerance-window assertion against the production clock (oauth2/client.ts computes expiry via Date.now)
    expect(Math.abs(bundle.expires_at!.getTime() - expectedMs)).toBeLessThan(5_000);
  });

  seamTest("throws when JSON envelope is missing access_token", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "unsupported_grant_type" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    let caught: Error | null = null;
    try {
      await runClientCredentialsJsonGrant({
        token_endpoint: "https://example.test/token",
        body_mapping: { client_id: "cid", client_secret: "sec" },
        response_format: "json",
        token_response_ttl_ms: 86_400_000,
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toContain("access_token");
  });
});

describe("runClientCredentialsJsonGrant — extra_token_headers forwarded", () => {
  seamTest("forwards extra_token_headers onto the token POST", async () => {
    fetchSpy.mockResolvedValue(
      new Response('"tok"', { status: 200, headers: { "content-type": "text/plain" } }),
    );

    await runClientCredentialsJsonGrant({
      token_endpoint: "https://example.test/auth",
      body_mapping: { client_id: "cid", client_secret: "sec" },
      response_format: "raw",
      token_response_ttl_ms: 86_400_000,
      extra_token_headers: { "x-custom": "value" },
    });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-custom"]).toBe("value");
  });
});
