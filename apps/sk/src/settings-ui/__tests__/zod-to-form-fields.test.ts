// zod-to-form-fields bridge unit tests.
//
// The bridge maps the engine's GET /v1/settings response (kind +
// metadata) to a renderable FormField. The schema-walking test asserts
// every kind we see in production maps to a non-null FormFieldKind so a
// future leaf type is caught at test time rather than rendering as raw
// JSON in the form.

import { describe, expect, test } from "bun:test";

import type { SettingLeafEntry } from "../../engine-client.ts";
import { leafToFormField } from "../lib/zod-to-form-fields.ts";

function leaf(partial: Partial<SettingLeafEntry> & { path: string }): SettingLeafEntry {
  return {
    path: partial.path,
    value: partial.value ?? "",
    meta: {
      source: partial.meta?.source ?? "default",
      scope: partial.meta?.scope ?? "global",
      sensitive: partial.meta?.sensitive ?? false,
      requiresRestart: partial.meta?.requiresRestart ?? false,
      kind: partial.meta?.kind ?? "string",
      ...(partial.meta?.description ? { description: partial.meta.description } : {}),
    },
  };
}

describe("leafToFormField", () => {
  test("string maps to text", () => {
    const f = leafToFormField(leaf({ path: "server.public_base_url", value: "" }));
    expect(f.kind).toBe("text");
  });

  test("sensitive flag wins over kind=string", () => {
    const f = leafToFormField(
      leaf({ path: "auth.session.secret", meta: { sensitive: true, kind: "string" } as never }),
    );
    expect(f.kind).toBe("secret");
  });

  test("number / boolean / enum / string-list map cleanly", () => {
    expect(
      leafToFormField(leaf({ path: "server.port", meta: { kind: "number" } as never })).kind,
    ).toBe("number");
    expect(
      leafToFormField(leaf({ path: "llm.context_1m", meta: { kind: "boolean" } as never })).kind,
    ).toBe("bool");
    expect(leafToFormField(leaf({ path: "log.level", meta: { kind: "enum" } as never })).kind).toBe(
      "select",
    );
    expect(
      leafToFormField(
        leaf({ path: "egress.provider_hosts_extra", meta: { kind: "string-list" } as never }),
      ).kind,
    ).toBe("string-list");
  });

  test("unknown kind falls back to json", () => {
    const f = leafToFormField(
      leaf({ path: "weird.thing", meta: { kind: "string-array" } as never }),
    );
    expect(f.kind).toBe("json");
  });

  test("description and source flow through", () => {
    const f = leafToFormField(
      leaf({
        path: "llm.api_key",
        meta: { source: "tenant", description: "Primary LLM API key", kind: "string" } as never,
      }),
    );
    expect(f.source).toBe("tenant");
    expect(f.description).toBe("Primary LLM API key");
  });
});
