import { describe, expect, it } from "bun:test";
import { zodSchema } from "ai";
import Ajv from "ajv";
import { compileDescription } from "../describe.ts";
import { listTools } from "../index.ts";
import { toInputExamples } from "../sdk-wrap/invoke.ts";

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

  it("every example validates against the sealed JSON-Schema projection the provider checks", () => {
    const compatible: string[] = [];
    const incompatible: { name: string; reasons: string[] }[] = [];

    for (const t of listTools()) {
      if (!t.example_input) continue;
      const js = zodSchema(t.inputSchema).jsonSchema;
      const result = validateExample(js, t.example_input);
      if (result.ok) compatible.push(t.name);
      else incompatible.push({ name: t.name, reasons: result.errors.slice(0, 3) });
    }

    expect(compatible).toContain("save_learning");
    expect(compatible).toContain("probe_connector");
    expect(incompatible).toEqual([]);
  });

  it("the example travels as a tool input example, not inside the description", () => {
    const withExamples = listTools().filter((t) => t.example_input);
    expect(withExamples.length).toBeGreaterThan(0);
    for (const t of withExamples) {
      expect(toInputExamples(t.example_input)).toEqual({
        inputExamples: [{ input: t.example_input as Record<string, unknown> }],
      });
      expect(compileDescription(t)).not.toContain("<example>");
    }
  });

  it("no example carries an id-shaped value the model could copy as a real id", () => {
    const uuidShaped = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const copyable = listTools()
      .filter((t) => t.example_input && uuidShaped.test(JSON.stringify(t.example_input)))
      .map((t) => t.name);
    expect(copyable).toEqual([]);
  });
});
