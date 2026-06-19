import { describe, expect, test } from "bun:test";
import { errorFields } from "./logger.ts";
import { redact } from "./redact.ts";

describe("redact", () => {
  test("redacts case-insensitive denylist keys", () => {
    const input = {
      Authorization: "Bearer abc123",
      password: "hunter2",
      token: "xoxb-123",
      nested: { Cookie: "session=abc" },
      safe: "ok",
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.Authorization).toBe("***redacted***");
    expect(out.password).toBe("***redacted***");
    expect(out.token).toBe("***redacted***");
    expect((out.nested as Record<string, unknown>).Cookie).toBe("***redacted***");
    expect(out.safe).toBe("ok");
  });

  test("scrubs bearer tokens in free-form strings", () => {
    const input = { note: "use Bearer xyz123 to call" };
    const out = redact(input) as Record<string, unknown>;
    expect(out.note).not.toContain("xyz123");
  });

  test("scrubs wf_live_ api keys in free-form strings", () => {
    const input = { hint: "try wf_live_abc123def456 to auth" };
    const out = redact(input) as Record<string, unknown>;
    expect(out.hint).not.toContain("wf_live_abc123def456");
  });

  test("scrubs DigitalOcean PATs (dop_v1_…) in free-form strings", () => {
    const token = "dop_v1_a9053683abcdefabcdefabcdefabcdefabcdef";
    const input = { note: `paste ${token} into the form` };
    const out = redact(input) as Record<string, unknown>;
    expect(out.note).not.toContain(token);
    expect(out.note).toContain("***REDACTED:pat***");
  });

  test("scrubs JWTs in free-form strings", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefSignature";
    const input = { note: `cookie=${jwt}` };
    const out = redact(input) as Record<string, unknown>;
    expect(out.note).not.toContain(jwt);
    expect(out.note).toContain("***REDACTED:jwt***");
  });

  test("keeps the engine logger depth ceiling at 4", () => {
    const input = {
      level0: {
        level1: {
          level2: {
            level3: {
              level4: {
                secret: "wf_live_very_secret_value",
              },
            },
          },
        },
      },
    };
    const out = redact(input);
    expect(JSON.stringify(out)).toContain("[depth-exceeded]");
  });
});

describe("errorFields", () => {
  test("returns String(err) for non-Error thrown values", () => {
    expect(errorFields("plain string")).toEqual({ error: "plain string" });
    expect(errorFields(42)).toEqual({ error: "42" });
    expect(errorFields(null)).toEqual({ error: "null" });
  });

  test("surfaces err.cause as a sibling field — drizzle-orm puts the pg error there", () => {
    const pgErr = new Error("connection terminated unexpectedly");
    const wrapped = new Error("Failed query: select 1\nparams: ");
    wrapped.cause = pgErr;
    const out = errorFields(wrapped);
    expect(out.error).toBe("Failed query: select 1\nparams: ");
    expect(out.cause).toBe("connection terminated unexpectedly");
    expect(typeof out.stack).toBe("string");
  });

  test("stringifies non-Error causes", () => {
    const wrapped = new Error("outer");
    wrapped.cause = { code: "ECONNRESET" };
    const out = errorFields(wrapped);
    expect(out.cause).toBe("[object Object]");
  });

  test("omits cause when undefined", () => {
    const out = errorFields(new Error("plain"));
    expect(out.error).toBe("plain");
    expect(out.cause).toBeUndefined();
  });
});
