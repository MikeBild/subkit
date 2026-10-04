import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetEngineSchemaCacheForTests,
  type EngineSchemaSource,
  loadEngineSchema,
  materializeSchema,
} from "../settings-ui/lib/engine-schema-loader.ts";

beforeEach(() => _resetEngineSchemaCacheForTests());
afterEach(() => _resetEngineSchemaCacheForTests());

describe("engine schema loader", () => {
  test("materializeSchema produces a Zod object usable by SchemaForm", () => {
    const z = materializeSchema({
      fields: {
        name: { type: "string" },
        age: { type: "number", optional: true },
        active: { type: "boolean" },
        role: { type: "enum", enumValues: ["admin", "user"] },
      },
    });
    const ok = z.safeParse({ name: "alice", active: true, role: "admin" });
    expect(ok.success).toBe(true);
    const fail = z.safeParse({ name: "bob", active: "yes", role: "ghost" });
    expect(fail.success).toBe(false);
  });

  test("loadEngineSchema memoizes by name", async () => {
    let calls = 0;
    const source: EngineSchemaSource = {
      fetchDescriptor: async () => {
        calls++;
        return { fields: { x: { type: "string" } } };
      },
    };
    await loadEngineSchema(source, "tenant.settings");
    await loadEngineSchema(source, "tenant.settings");
    expect(calls).toBe(1);
  });

  test("loadEngineSchema with force=true re-fetches", async () => {
    let calls = 0;
    const source: EngineSchemaSource = {
      fetchDescriptor: async () => {
        calls++;
        return { fields: {} };
      },
    };
    await loadEngineSchema(source, "x");
    await loadEngineSchema(source, "x", { force: true });
    expect(calls).toBe(2);
  });

  test("empty enum throws by default (fail loud, not coerce)", () => {
    expect(() => materializeSchema({ fields: { kind: { type: "enum", enumValues: [] } } })).toThrow(
      /empty_enum_values|enumValues/i,
    );
  });

  // R7-S4: dropped the `permissive: true` escape hatch — no in-tree
  // caller used it. Re-add when a real bug-report path needs the
  // fallback shape.
  test("unknown field types throw", () => {
    expect(() =>
      materializeSchema({
        fields: {
          x: { type: "object" as unknown as "string" },
        },
      }),
    ).toThrow(/unknown_field_type|unsupported descriptor/i);
  });
});
