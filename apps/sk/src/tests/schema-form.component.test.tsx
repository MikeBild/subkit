import { describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
import { z } from "zod";
import { _describeFieldsForTests, SchemaForm } from "../domain/schema/SchemaForm.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

describe("describeFields", () => {
  test("walks a flat ZodObject", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      active: z.boolean(),
      role: z.enum(["admin", "user"]),
    });
    const fields = _describeFieldsForTests(schema);
    expect(fields).toEqual([
      { key: "name", kind: "string", required: true },
      { key: "age", kind: "number", required: true },
      { key: "active", kind: "boolean", required: true },
      { key: "role", kind: "enum", required: true, options: ["admin", "user"] },
    ]);
  });

  test("marks ZodOptional fields as not required", () => {
    const schema = z.object({
      hint: z.string().optional(),
    });
    expect(_describeFieldsForTests(schema)[0]).toMatchObject({
      key: "hint",
      kind: "string",
      required: false,
    });
  });

  test("returns empty array for non-object schemas", () => {
    expect(_describeFieldsForTests(z.string())).toEqual([]);
  });
});

describe("<SchemaForm>", () => {
  test("form mode renders one row per field", async () => {
    const schema = z.object({
      host: z.string(),
      port: z.number(),
    });
    const ui = renderInk(
      <ThemeProvider>
        <SchemaForm
          schema={schema}
          value={{ host: "localhost", port: 5432 }}
          onChange={() => undefined}
          mode="form"
          onModeChange={() => undefined}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("host");
      expect(text).toContain("localhost");
      expect(text).toContain("port");
      expect(text).toContain("5432");
    } finally {
      ui.unmount();
    }
  });

  test("code mode renders the JSON body and validates on Enter", async () => {
    const schema = z.object({ a: z.number() });
    let captured: { a: number } | null = null;
    const ui = renderInk(
      <ThemeProvider>
        <SchemaForm
          schema={schema}
          value={{ a: 1 }}
          onChange={(v) => {
            captured = v as { a: number };
          }}
          mode="code"
          onModeChange={() => undefined}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text()).toContain('"a": 1');
      await ui.press("enter");
      await flush();
      expect((captured as { a: number } | null)?.a).toBe(1);
    } finally {
      ui.unmount();
    }
  });

  test("code mode shows a parse error when JSON is invalid", async () => {
    const schema = z.object({ a: z.number() });
    const ui = renderInk(
      <ThemeProvider>
        <SchemaForm
          schema={schema}
          value={{ a: 1 }}
          onChange={() => undefined}
          mode="code"
          onModeChange={() => undefined}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      await ui.type("xx");
      await flush();
      await ui.press("enter");
      await flush();
      expect(ui.text()).toContain("parse error");
    } finally {
      ui.unmount();
    }
  });

  test("renders engine validation errors next to fields in form mode", async () => {
    const schema = z.object({ host: z.string() });
    const ui = renderInk(
      <ThemeProvider>
        <SchemaForm
          schema={schema}
          value={{ host: "" }}
          onChange={() => undefined}
          mode="form"
          onModeChange={() => undefined}
          errors={[{ path: "host", message: "host is required" }]}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text()).toContain("host is required");
    } finally {
      ui.unmount();
    }
  });
});
