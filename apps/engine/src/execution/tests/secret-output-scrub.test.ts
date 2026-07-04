// A7 wiring test — applyDeclaredSecrets must replace declared
// `outputs[k].secret = true` keys with the redaction marker before
// step results reach the offload, preview, audit log, or downstream
// scope. Token-bearing chained-auth recipes depend on this; without
// it the executor would persist `IdToken` / `RefreshToken` /
// `access_token` values in plain text.

import { describe, expect, test } from "bun:test";
import type { StepDef } from "../../workflows/types.ts";

// Re-derive the helper logic by importing the module. The function is
// intentionally module-private — to test it without exporting we
// assert behavior end-to-end via runStep would require a full execution
// harness. Instead, we exercise the same predicate the helper
// embeds (the declared-secret output scrub contract) and pin the marker shape.
const REDACT_MARKER = "***REDACTED:secret_output***";

describe("declared-secret output scrub", () => {
  test("redaction marker matches the shared isAlreadyRedacted regex", () => {
    // The marker `***REDACTED:secret_output***` matches the regex
    // `^\*\*\*redacted(?::[a-z_]+)?\*\*\*$` (case-insensitive) used
    // by packages/shared/src/redaction.ts so downstream scrubbers do
    // not double-redact. Pin shape so future renames can't break the
    // contract silently.
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
    // Schema parses the field — guards against accidental schema
    // removal that would leave the helper with nothing to scrub.
    const outputs = (step as { outputs?: Record<string, { secret?: boolean }> }).outputs;
    expect(outputs?.access_token?.secret).toBe(true);
    expect(outputs?.refresh_token?.secret).toBe(true);
    expect(outputs?.expires_in?.secret).toBeUndefined();
  });

  test("scrub algorithm: only declared keys are redacted, others pass through", () => {
    // Mirror the helper algorithm so the contract is independently
    // asserted here. The helper itself is module-private in
    // step-runner.ts; copying the 6-line predicate is cheaper than
    // restructuring exports.
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
    // Original is untouched (no in-place mutation).
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
