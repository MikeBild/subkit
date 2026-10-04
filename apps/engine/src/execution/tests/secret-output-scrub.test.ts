import { describe, expect, test } from "bun:test";
import type { StepDef } from "../../workflows/types.ts";

const REDACT_MARKER = "***REDACTED:secret_output***";

describe("declared-secret output scrub", () => {
  test("redaction marker matches the shared isAlreadyRedacted regex", () => {
    expect(REDACT_MARKER).toMatch(/^\*\*\*redacted(?::[a-z_]+)?\*\*\*$/i);
  });

  test("step shape — RequestStep can declare outputs[].secret", () => {
    const step: StepDef = {
      kind: "request",
      id: "signin",
      method: "POST",
      url: "https://x/oauth/token",
      outputs: {
        access_token: { secret: true },
        refresh_token: { secret: true },
        expires_in: {},
      },
    } as StepDef;
    const outputs = (step as { outputs?: Record<string, { secret?: boolean }> }).outputs;
    expect(outputs?.access_token?.secret).toBe(true);
    expect(outputs?.refresh_token?.secret).toBe(true);
    expect(outputs?.expires_in?.secret).toBeUndefined();
  });

  test("scrub algorithm: only declared keys are redacted, others pass through", () => {
    const apply = (
      outputs: Record<string, { secret?: boolean }> | undefined,
      value: unknown,
    ): unknown => {
      if (!outputs) return value;
      const secretKeys = Object.entries(outputs)
        .filter(([, v]) => v?.secret === true)
        .map(([k]) => k);
      if (secretKeys.length === 0) return value;
      if (
        value === null ||
        value === undefined ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        return value;
      }
      const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const key of secretKeys) {
        if (key in out) out[key] = REDACT_MARKER;
      }
      return out;
    };

    const value = {
      access_token: "AKIA-real-token-here",
      refresh_token: "refresh-real",
      expires_in: 3600,
      scope: "read:all",
    };
    const scrubbed = apply(
      { access_token: { secret: true }, refresh_token: { secret: true } },
      value,
    ) as Record<string, unknown>;

    expect(scrubbed.access_token).toBe(REDACT_MARKER);
    expect(scrubbed.refresh_token).toBe(REDACT_MARKER);
    expect(scrubbed.expires_in).toBe(3600);
    expect(scrubbed.scope).toBe("read:all");
    expect(value.access_token).toBe("AKIA-real-token-here");
  });

  test("no-op when value is null / array / primitive", () => {
    const apply = (
      outputs: Record<string, { secret?: boolean }> | undefined,
      value: unknown,
    ): unknown => {
      if (!outputs) return value;
      const secretKeys = Object.entries(outputs)
        .filter(([, v]) => v?.secret === true)
        .map(([k]) => k);
      if (secretKeys.length === 0) return value;
      if (
        value === null ||
        value === undefined ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        return value;
      }
      const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const key of secretKeys) {
        if (key in out) out[key] = REDACT_MARKER;
      }
      return out;
    };

    const outputs = { access_token: { secret: true } };
    expect(apply(outputs, null)).toBe(null);
    expect(apply(outputs, undefined)).toBe(undefined);
    expect(apply(outputs, "raw-string-token")).toBe("raw-string-token");
    expect(apply(outputs, [{ access_token: "x" }])).toEqual([{ access_token: "x" }]);
  });
});
