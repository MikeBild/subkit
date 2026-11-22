import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { probeWarnings, renderProbeOutcome } from "./connectors.ts";

type ConnectorProbeResult = components["schemas"]["ConnectorProbeResult"];

const UNVERIFIED = {
  ok: false,
  latency_ms: 12,
  status: 401,
  warning_only: true,
  error_code: "credential_unverified",
  warnings: [
    {
      code: "PROBE_AUTH_UNVERIFIED",
      message:
        "Fallback probe GET / returned 401: the root path requires sign-in, so the credential was not verified. Set config.probe_endpoint to a cheap authenticated read.",
    },
  ],
} satisfies ConnectorProbeResult;

let restore: (() => void) | null = null;

const plain = (text: string) =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

function captureStdout(): string[] {
  const lines: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  restore = () => spy.mockRestore();
  return lines;
}

afterEach(() => {
  restore?.();
  restore = null;
});

describe("subkit connectors test output", () => {
  test("an unverified root probe names the reason and shows the probe_endpoint warning", () => {
    const lines = captureStdout();
    const passed = renderProbeOutcome(UNVERIFIED, false);
    const out = plain(lines.join(""));
    expect(passed).toBe(false);
    expect(out).toContain("reason: credential_unverified");
    expect(out).toContain("config.probe_endpoint");
    expect(out).toContain("(PROBE_AUTH_UNVERIFIED)");
  });

  test("an ambiguous successful probe still prints its warning", () => {
    const lines = captureStdout();
    const passed = renderProbeOutcome(
      {
        ok: true,
        latency_ms: 8,
        warnings: [{ code: "PROBE_AMBIGUOUS", message: "Fallback probe GET / returned 404." }],
      },
      false,
    );
    expect(passed).toBe(true);
    expect(lines.join("")).toContain("(PROBE_AMBIGUOUS)");
  });

  test("malformed warnings are ignored", () => {
    expect(probeWarnings(undefined)).toEqual([]);
    expect(probeWarnings([{ code: 1 }, "x", { code: "A", message: "b" }])).toEqual([
      { code: "A", message: "b" },
    ]);
  });
});
