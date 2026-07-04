import { describe, expect, test } from "bun:test";
import { parseCurlCommand } from "./curl.ts";

describe("parseCurlCommand", () => {
  test("parses a minimal GET curl command", () => {
    const result = parseCurlCommand("curl https://api.example.com/users");
    expect(result.url).toBe("https://api.example.com/users");
    expect(result.method).toBe("GET");
    expect(result.body).toBeNull();
  });

  test("-X flag sets the HTTP method", () => {
    const result = parseCurlCommand("curl -X DELETE https://api.example.com/users/1");
    expect(result.method).toBe("DELETE");
  });

  test("--request flag sets the HTTP method", () => {
    const result = parseCurlCommand("curl --request PATCH https://api.example.com/items/5");
    expect(result.method).toBe("PATCH");
  });

  test("-H flag adds a header", () => {
    const result = parseCurlCommand(
      "curl -H 'Content-Type: application/json' https://api.example.com",
    );
    expect(result.headers["Content-Type"]).toBe("application/json");
  });

  test("multiple -H flags are all captured", () => {
    const result = parseCurlCommand(
      "curl -H 'Accept: application/json' -H 'X-Request-ID: abc123' https://api.example.com",
    );
    expect(result.headers.Accept).toBe("application/json");
    expect(result.headers["X-Request-ID"]).toBe("abc123");
  });

  test("-d sets body and upgrades GET to POST", () => {
    const result = parseCurlCommand('curl -d \'{"name":"Alice"}\' https://api.example.com/users');
    expect(result.method).toBe("POST");
    expect(result.body).toBe('{"name":"Alice"}');
  });

  test("--data-raw sets body", () => {
    const result = parseCurlCommand("curl --data-raw 'payload' https://api.example.com/hook");
    expect(result.body).toBe("payload");
  });

  test("-u flag sets Basic auth header", () => {
    const result = parseCurlCommand("curl -u user:pass https://api.example.com");
    expect(result.headers.Authorization).toContain("Basic ");
    expect(result.auth_hint?.type).toBe("basic");
  });

  test("Bearer token in Authorization header detected", () => {
    const result = parseCurlCommand(
      "curl -H 'Authorization: Bearer sk_test_abc' https://api.stripe.com/v1/customers",
    );
    expect(result.auth_hint?.type).toBe("bearer");
  });

  test("Basic auth in Authorization header detected", () => {
    const result = parseCurlCommand(
      "curl -H 'Authorization: Basic dXNlcjpwYXNz' https://api.example.com",
    );
    expect(result.auth_hint?.type).toBe("basic");
  });

  test("custom header auth detected for X-API-Key style", () => {
    const result = parseCurlCommand("curl -H 'X-API-Key: my-key' https://api.example.com");
    expect(result.auth_hint?.type).toBe("header");
  });

  test("no auth header → auth_hint type is none", () => {
    const result = parseCurlCommand("curl https://public.api.example.com/data");
    expect(result.auth_hint?.type).toBe("none");
  });

  test("throws when command does not start with curl", () => {
    expect(() => parseCurlCommand("wget https://api.example.com")).toThrow();
  });

  test("quoted URL is unquoted", () => {
    const result = parseCurlCommand("curl 'https://api.example.com/path'");
    expect(result.url).toBe("https://api.example.com/path");
  });

  test("-X with -d preserves explicit method", () => {
    const result = parseCurlCommand(
      'curl -X PUT -d \'{"name":"Bob"}\' https://api.example.com/users/1',
    );
    expect(result.method).toBe("PUT");
  });
});
