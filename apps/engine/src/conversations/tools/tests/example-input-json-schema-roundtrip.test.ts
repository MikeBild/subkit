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
    const compatible: string[] = [];
    const incompatible: { name: string; reasons: string[] }[] = [];

    for (const t of listTools()) {
      if (!t.example_input) continue;
      const js = zodSchema(t.inputSchema).jsonSchema;
      const result = validateExample(js, t.example_input);
      if (result.ok) compatible.push(t.name);
      else incompatible.push({ name: t.name, reasons: result.errors.slice(0, 3) });
    }

    expect(compatible).toContain("propose_skill");

    expect(incompatible.map((t) => t.name).sort()).toEqual(["probe_connector"]);
  });

  it("no example carries an id-shaped value the model could copy as a real id", () => {
    const uuidShaped = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const copyable = listTools()
      .filter((t) => t.example_input && uuidShaped.test(JSON.stringify(t.example_input)))
      .map((t) => t.name);
    expect(copyable).toEqual([]);
  });
});
