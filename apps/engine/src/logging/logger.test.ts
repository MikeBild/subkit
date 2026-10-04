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
    expect(errorFields(new Error("boom")).error_class).toBe("unknown");
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
    expect(blob.startsWith("x".repeat(2048))).toBe(true);
    expect(blob).toContain("…[truncated 2952 chars]");
    expect(blob.length).toBeLessThan(huge.length);
  });

  test("caps by character count, not bytes (multibyte field)", () => {
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

describe("sd-daemon priority prefix", () => {
  function captureRawLine(env: Record<string, string | undefined>, fn: () => void): string {
    const savedEnv: Record<string, string | undefined> = {
      SK_LOG_SD_DAEMON: process.env.SK_LOG_SD_DAEMON,
      JOURNAL_STREAM: process.env.JOURNAL_STREAM,
    };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetLoggerForTests();
    reconfigureLogger({ format: "ndjson", level: "trace" });
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
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      _resetLoggerForTests();
    }
    return captured.trim();
  }

  test("maps error→<3> and warn→<4> when SK_LOG_SD_DAEMON=1", () => {
    const errLine = captureRawLine({ SK_LOG_SD_DAEMON: "1", JOURNAL_STREAM: undefined }, () =>
      logger.error({ module: "t", action: "a", msg: "boom" }),
    );
    expect(errLine.startsWith("<3>{")).toBe(true);
    const warnLine = captureRawLine({ SK_LOG_SD_DAEMON: "1", JOURNAL_STREAM: undefined }, () =>
      logger.warn({ module: "t", action: "a" }),
    );
    expect(warnLine.startsWith("<4>{")).toBe(true);
  });

  test("maps fatal→<2>, info→<6>, debug/trace→<7>", () => {
    const env = { SK_LOG_SD_DAEMON: "1", JOURNAL_STREAM: undefined };
    expect(
      captureRawLine(env, () => logger.fatal({ module: "t", action: "a" })).startsWith("<2>{"),
    ).toBe(true);
    expect(
      captureRawLine(env, () => logger.info({ module: "t", action: "a" })).startsWith("<6>{"),
    ).toBe(true);
    expect(
      captureRawLine(env, () => logger.debug({ module: "t", action: "a" })).startsWith("<7>{"),
    ).toBe(true);
    expect(
      captureRawLine(env, () => logger.trace({ module: "t", action: "a" })).startsWith("<7>{"),
    ).toBe(true);
  });

  test("keeps the JSON payload unchanged after the marker", () => {
    const line = captureRawLine({ SK_LOG_SD_DAEMON: "1", JOURNAL_STREAM: undefined }, () =>
      logger.error({ module: "t", action: "a", msg: "boom" }),
    );
    const rec = JSON.parse(line.slice("<3>".length)) as Record<string, unknown>;
    expect(rec.level).toBe("error");
    expect(rec.module).toBe("t");
    expect(rec.msg).toBe("boom");
  });

  test("emits bare JSON without the flag and without JOURNAL_STREAM", () => {
    const line = captureRawLine({ SK_LOG_SD_DAEMON: undefined, JOURNAL_STREAM: undefined }, () =>
      logger.error({ module: "t", action: "a" }),
    );
    expect(line.startsWith("{")).toBe(true);
  });

  test("auto-enables when systemd exports JOURNAL_STREAM", () => {
    const line = captureRawLine({ SK_LOG_SD_DAEMON: undefined, JOURNAL_STREAM: "9:12345" }, () =>
      logger.error({ module: "t", action: "a" }),
    );
    expect(line.startsWith("<3>{")).toBe(true);
  });

  test("SK_LOG_SD_DAEMON=0 force-disables even under JOURNAL_STREAM", () => {
    const line = captureRawLine({ SK_LOG_SD_DAEMON: "0", JOURNAL_STREAM: "9:12345" }, () =>
      logger.error({ module: "t", action: "a" }),
    );
    expect(line.startsWith("{")).toBe(true);
  });
});
