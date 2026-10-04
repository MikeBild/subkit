import { beforeEach, describe, expect, test } from "bun:test";
import { redactPayload, resetLangfuseCacheForReload, startToolSpan } from "../langfuse-spans.ts";

describe("redactPayload — sensitive key masking", () => {
  test("top-level sensitive keys are replaced with [REDACTED]", () => {
    const out = redactPayload({
      authorization: "Bearer sk-live-ABC123",
      api_key: "k-secret-99",
      x_api_key: "header-form",
      cookie: "session=abc",
      normal: "public-value",
    }) as Record<string, string>;
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.x_api_key).toBe("[REDACTED]");
    expect(out.cookie).toBe("[REDACTED]");
    expect(out.normal).toBe("public-value");
  });

  test("nested sensitive keys are recursively redacted", () => {
    const out = redactPayload({
      headers: {
        Authorization: "Bearer sk-live-xyz",
        "X-API-Key": "some-key",
        "User-Agent": "sk-cli/1.0",
      },
    }) as { headers: Record<string, string> };
    expect(out.headers.Authorization).toBe("[REDACTED]");
    expect(out.headers["X-API-Key"]).toBe("[REDACTED]");
    expect(out.headers["User-Agent"]).toBe("sk-cli/1.0");
  });

  test("case-insensitive key matching", () => {
    const out = redactPayload({
      PASSWORD: "p@ss",
      ClientSecret: "shh",
      client_secret: "shh2",
      refresh_Token: "rt",
    }) as Record<string, string>;
    expect(out.PASSWORD).toBe("[REDACTED]");
    expect(out.ClientSecret).toBe("[REDACTED]");
    expect(out.client_secret).toBe("[REDACTED]");
    expect(out.refresh_Token).toBe("[REDACTED]");
  });
});

describe("redactPayload — value-shape masking", () => {
  test("Bearer-prefixed string values are masked", () => {
    const out = redactPayload(["Bearer sk-live-ABCDEFGHIJKLM", "not a bearer"]) as string[];
    expect(out[0]).toBe("[REDACTED]");
    expect(out[1]).toBe("not a bearer");
  });

  test("long alphanum+dash secret-looking values are masked", () => {
    const out = redactPayload({
      n: "sk_live_1a2b3c4d5e6f7g8h9i0j1k2l3m4n",
    }) as Record<string, string>;
    expect(out.n).toBe("[REDACTED]");
  });

  test("UUIDs pass through (they're used as tenant ids)", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const out = redactPayload({ tenant_id: uuid }) as Record<string, string>;
    expect(out.tenant_id).toBe(uuid);
  });

  test("short public strings pass through", () => {
    const out = redactPayload({ slug: "stripe", env: "dev" }) as Record<string, string>;
    expect(out.slug).toBe("stripe");
    expect(out.env).toBe("dev");
  });
});

describe("redactPayload — placeholder-token visibility", () => {
  test(`\${cred.*} tokens are marked but not fully masked (they're names, not values)`, () => {
    const out = redactPayload({
      Authorization: "ok",
      note: `using \${cred.stripe.token} for auth`,
    }) as Record<string, string>;
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.note).toBe(`using \${cred.REDACTED} for auth`);
  });

  test("secret-shaped value under a sensitive key is fully masked", () => {
    const CANARY = "sk0live9a7cT8hm2qPv9eG1R3kS4bV5n";
    const input = {
      headers: {
        Authorization: `Bearer ${CANARY}`,
      },
      api_key: CANARY,
      token: CANARY,
    };
    const out = JSON.stringify(redactPayload(input));
    expect(out.includes(CANARY)).toBe(false);
  });

  test("secret-shaped value as a standalone string is value-pattern-masked", () => {
    const v = "abc1def2ghi3jkl4mno5pqr6stu7vw8";
    const out = redactPayload(v);
    const long = `${v}x`;
    const outLong = redactPayload(long);
    expect(out).toBe(v);
    expect(outLong).toBe("[REDACTED]");
  });
});

describe("redactPayload — type preservation", () => {
  test("primitives pass through unchanged (except secret-shaped strings)", () => {
    expect(redactPayload(42)).toBe(42);
    expect(redactPayload(true)).toBe(true);
    expect(redactPayload(null)).toBe(null);
    expect(redactPayload(undefined)).toBe(undefined);
  });

  test("arrays of objects: each element is deep-redacted", () => {
    const out = redactPayload([
      { authorization: "x", public: 1 },
      { authorization: "y", public: 2 },
    ]) as Array<Record<string, unknown>>;
    expect(out[0]!.authorization).toBe("[REDACTED]");
    expect(out[0]!.public).toBe(1);
    expect(out[1]!.authorization).toBe("[REDACTED]");
    expect(out[1]!.public).toBe(2);
  });

  test("empty object and empty array round-trip", () => {
    expect(redactPayload({})).toEqual({});
    expect(redactPayload([])).toEqual([]);
  });
});

describe("startToolSpan — no-op when Langfuse keys are absent", () => {
  beforeEach(() => {
    resetLangfuseCacheForReload();
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
  });

  test("returns inert span with active=false", async () => {
    const span = await startToolSpan({
      name: "probe_connector",
      input: { connector_slug: "stripe" },
      metadata: { tenant_id: "t" },
    });
    expect(span.active).toBe(false);
    await span.finish({ output: { ok: true }, status: "success" });
    await span.finish({ output: { ok: true }, status: "success" });
  });
});
