// Regression guard for the v4.6.0 `tools.N.custom: Example at index 0
// is invalid: False schema does not allow <value>` outage.
//
// Origin. Each tool's `example_input` is emitted on the
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

describe("tool example_input ↔ inputSchema round-trip (post-incident guard)", () => {
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

    // Hard assertion: at minimum, the strict-opted-in tool
    // (propose_skill) must round-trip — it's the only tool whose
    // schema is fully concrete and was specifically chosen for the
    // strict channel.
    expect(compatible).toContain("propose_skill");

    // Pin the *exact* set of tools that cannot ship `inputExamples`
    // today. Adding a new offending tool, OR fixing one of the three
    // listed, both fail this assertion — the failure message points
    // at the projection / record-mismatch problem so the engineer can
    // either tighten the example or update the snapshot. When all
    // three drop off (upstream projection fix OR each tool drops
    // `z.record(...)`), flip the assertion to `toEqual([])` and
    // re-enable `toInputExamples()` in sdk-wrap/invoke.ts.
    //
    // Replaces the prior `void incompatible` discard so a
    // NEW offender lights up CI instead of slipping through silently.
    //
    // MAINTENANCE RULE: if you are tightening one
    // of these tools' `example_input` or its `inputSchema` and the
    // snapshot test fails, REMOVE the corresponding entry from this
    // array. DO NOT append a new tool to make the test pass — the
    // whole point of pinning the set is to force a new offender to be
    // discussed (either tighten its example or accept the regression
    // explicitly).
    expect(incompatible.map((t) => t.name).sort()).toEqual([
      "build_workflow",
      "call_connector",
      "probe_connector",
    ]);
  });
});
