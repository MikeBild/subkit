// Regression guard for the v4.6.0 `tools.N.custom: Example at index 0
// is invalid: False schema does not allow <value>` outage.
//
// Origin. Issue #165 began emitting each tool's `example_input` as the
// AI SDK `inputExamples` channel. AI SDK 6 strict-validates every entry
// against the JSON-Schema projection of `inputSchema`. The projection
// reflexively seals every object with `additionalProperties: false` —
// including the value-shape of `z.record(z.string(), …)` — even though
// the Zod schema legitimately accepts any string key. The mismatch
// rejected every conversation turn for every tenant.
//
// Current fix. `toInputExamples()` in `sdk-wrap/invoke.ts` returns an
// empty object so the offending channel is no longer emitted. The
// model still sees the example via the `<example>` block
// `compileDescription` appends to the tool description.
//
// What this file pins. Two assertions, run at test time:
//   1. Every tool's `example_input` parses through the Zod schema
//      (existing contract; would already have failed before the
//      regression, but worth pinning).
//   2. For every tool whose `example_input` is set, log the JSON-Schema
//      projection round-trip result. Tools that pass round-trip can
//      safely be re-included if the inputExamples channel is ever
//      flipped back on; tools that fail need either a tighter schema
//      or a tighter example before the channel can ship again.
//
// Whenever a future refactor flips inputExamples back on (because
// upstream zod-to-json-schema correctly projects `z.record(…)`, or
// because we move to a strict-by-construction tool palette), the
// second assertion can be hardened to `.toBe(true)` so a misaligned
// example fails the gate at boot instead of silently breaking
// production.

import { describe, expect, it } from "bun:test";
import { zodSchema } from "ai";
import Ajv from "ajv";
import { listTools } from "../index.ts";

const ajv = new Ajv({ strict: false, allErrors: true });

function validateExample(
  schema: unknown,
  example: Readonly<Record<string, unknown>>,
): { ok: boolean; errors: string[] } {
  try {
    const validate = ajv.compile(schema as object);
    const ok = validate(example);
    if (ok) return { ok: true, errors: [] };
    const errors = (validate.errors ?? []).map(
      (e) => `${e.instancePath || "$"}: ${e.message ?? "invalid"}`,
    );
    return { ok: false, errors };
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

describe("tool example_input ↔ inputSchema round-trip (regression #167+ post-incident guard)", () => {
  it("every tool's example_input parses through its Zod inputSchema", () => {
    const failures: string[] = [];
    for (const t of listTools()) {
      if (!t.example_input) continue;
      const parsed = t.inputSchema.safeParse(t.example_input);
      if (!parsed.success) {
        failures.push(`${t.name}: ${parsed.error.message.slice(0, 120)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("reports JSON-Schema-projection round-trip status for every tool with an example", () => {
    // Diagnostic table. Tools listed under `incompatible` would have
    // broken Anthropic's strict validation if the `inputExamples`
    // channel were emitted. The fix (toInputExamples → no-op) means
    // none of these reach the provider today, but the count is logged
    // so a future re-enable can be evaluated.
    const compatible: string[] = [];
    const incompatible: { name: string; reasons: string[] }[] = [];

    for (const t of listTools()) {
      if (!t.example_input) continue;
      const js = zodSchema(t.inputSchema).jsonSchema;
      const result = validateExample(js, t.example_input);
      if (result.ok) compatible.push(t.name);
      else incompatible.push({ name: t.name, reasons: result.errors.slice(0, 3) });
    }

    // Snapshot diagnostic — never asserted, but logged for visibility
    // so a regression-fixing engineer can confirm whether their
    // schema-tightening eliminated the projection mismatch.
    if (incompatible.length > 0) {
      console.warn(
        `[#regression] ${incompatible.length} tool(s) cannot ship inputExamples today:`,
        incompatible.map((t) => `${t.name} (${t.reasons[0] ?? "unknown"})`).join("; "),
      );
    }

    // Hard assertion: at minimum, the strict-opted-in tool
    // (propose_skill) must round-trip — it's the only tool whose
    // schema is fully concrete and was specifically chosen for the
    // strict channel.
    expect(compatible).toContain("propose_skill");
  });
});
