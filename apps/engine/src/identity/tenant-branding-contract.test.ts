import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { updateTenantBrandingMcpTool } from "../mcp/tools/tenant-branding.ts";
import {
  TenantBrandingResponseSchema,
  TenantBrandingUpdateSchema,
} from "./tenant-branding-contract.ts";

type JsonProperties = Record<string, Record<string, unknown>>;
const reference = (language: "en" | "de") =>
  readFileSync(
    resolve(import.meta.dir, `../http/reference/cockpit-branding.${language}.md`),
    "utf8",
  );
const displayNameOf = (schema: z.ZodType) =>
  (z.toJSONSchema(schema) as { properties: JsonProperties }).properties.display_name;

describe("a workspace has one name (#523, #647)", () => {
  test("generated OpenAPI preserves branding deprecations and sensitive connector metadata", () => {
    const spec = JSON.parse(
      readFileSync(
        resolve(import.meta.dir, "../../../../packages/cli-core/src/engine-api/openapi.json"),
        "utf8",
      ),
    );
    const schemas = spec.components.schemas;
    for (const name of ["TenantBrandingUpdate", "TenantBrandingResponse"]) {
      expect(schemas[name].properties.display_name.deprecated).toBe(true);
      expect(schemas[name].properties.display_name.description).toContain(
        "PATCH /v1/identity/workspace",
      );
    }
    expect(schemas.SensitiveConnectorRef).toBeDefined();
    expect(schemas.SensitiveRequestMeta.properties.connector).toBeDefined();
    expect(schemas.SensitiveRequestMeta.required).not.toContain("pagination");
  });

  test("branding display_name stays accepted for compatibility", () => {
    const parsed = TenantBrandingUpdateSchema.parse({
      revision: 0,
      display_name: "Legacy name",
      subtitle: null,
      palette: null,
      logos: { light: { operation: "keep" }, dark: { operation: "keep" } },
    });
    expect(parsed.display_name).toBe("Legacy name");
  });

  test("request, response and MCP schemas mark display_name deprecated and point to the workspace name", () => {
    const fields = [
      displayNameOf(TenantBrandingUpdateSchema),
      displayNameOf(TenantBrandingResponseSchema),
      (updateTenantBrandingMcpTool.inputSchema.properties as JsonProperties).display_name,
    ];
    for (const field of fields) {
      expect(field?.deprecated).toBe(true);
      expect(String(field?.description)).toContain("not shown");
      expect(String(field?.description)).toContain("PATCH /v1/identity/workspace");
    }
  });

  test("the reference no longer promises a branding wordmark name and explains the rename", () => {
    const english = reference("en");
    const german = reference("de");
    expect(english).not.toContain("the wordmark, meaning the displayed name");
    expect(english).toContain("A workspace has exactly one name.");
    expect(english).toContain("`PATCH /v1/identity/workspace`");
    expect(english).toContain("The branding field `display_name` is deprecated.");
    expect(german).not.toContain("das Wortzeichen, also den angezeigten Namen");
    expect(german).toContain("Ein Arbeitsbereich hat genau einen Namen.");
    expect(german).toContain("`PATCH /v1/identity/workspace`");
    expect(german).toContain("Das Branding-Feld `display_name` ist veraltet.");
  });
});
