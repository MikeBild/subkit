import { describe, expect, test } from "bun:test";
import { withContext } from "./context.ts";
import {
  _resetLoggerForTests,
  errorFields,
  logger,
  reconfigureLogger,
  reconfigureObservability,
} from "./logger.ts";
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
    expect(errorFields("plain string")).toEqual({
      error: "plain string",
      error_class: "unknown",
    });
    expect(errorFields(42)).toEqual({ error: "42", error_class: "unknown" });
    expect(errorFields(null)).toEqual({ error: "null", error_class: "unknown" });
  });

  test("stamps error_class on every result", () => {
    // A plain Error with no recognised signal is "unknown".
    expect(errorFields(new Error("boom")).error_class).toBe("unknown");
    // A libpq connection drop is "transient" (via isTransientDbError).
    const transient = Object.assign(new Error("down"), { code: "ECONNREFUSED" });
    expect(errorFields(transient).error_class).toBe("transient");
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

describe("ndjson field-length cap", () => {
  function captureNdjson(fn: () => void): Record<string, unknown> {
    reconfigureLogger({ format: "ndjson", level: "info" });
    const orig = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      fn();
    } finally {
      process.stdout.write = orig as typeof process.stdout.write;
      _resetLoggerForTests();
    }
    return JSON.parse(captured.trim()) as Record<string, unknown>;
  }

  test("truncates a string field longer than the 2048 cap", () => {
    const huge = "x".repeat(5000);
    const rec = captureNdjson(() => logger.info({ module: "t", action: "a", blob: huge }));
    const blob = rec.blob as string;
    // 2048 kept chars + the truncation marker; original tail dropped.
    expect(blob.startsWith("x".repeat(2048))).toBe(true);
    expect(blob).toContain("…[truncated 2952 chars]");
    expect(blob.length).toBeLessThan(huge.length);
  });

  test("caps by character count, not bytes (multibyte field)", () => {
    // "한" is 1 UTF-16 code unit (String.length 1) but 3 UTF-8 bytes. The cap
    // is documented as characters, not bytes, so 5000 of them truncate at the
    // same 2048-char boundary as the ASCII case — dropping 2952 chars — even
    // though the byte length (~15 KB) is far larger.
    const huge = "한".repeat(5000);
    const rec = captureNdjson(() => logger.info({ module: "t", action: "a", blob: huge }));
    const blob = rec.blob as string;
    expect(blob.startsWith("한".repeat(2048))).toBe(true);
    expect(blob).toContain("…[truncated 2952 chars]");
  });

  test("leaves short string fields untouched", () => {
    const rec = captureNdjson(() => logger.info({ module: "t", action: "a", small: "ok" }));
    expect(rec.small).toBe("ok");
  });

  test("caps nested string fields too", () => {
    const huge = "y".repeat(3000);
    const rec = captureNdjson(() =>
      logger.info({ module: "t", action: "a", nested: { deep: huge } }),
    );
    const deep = (rec.nested as Record<string, unknown>).deep as string;
    expect(deep).toContain("…[truncated 952 chars]");
  });

  test("stamps OTel resource identity and W3C trace/span context", () => {
    reconfigureObservability({
      service_name: "subkit",
      deployment_environment: "production",
    });
    const rec = captureNdjson(() =>
      withContext(
        {
          trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
          span_id: "00f067aa0ba902b7",
        },
        () => logger.info({ module: "http", action: "contract.test" }),
      ),
    );
    expect(rec["service.name"]).toBe("subkit");
    expect(rec["service.version"]).toBeString();
    expect(rec["deployment.environment.name"]).toBe("production");
    expect(rec.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(rec.span_id).toBe("00f067aa0ba902b7");
  });
});
