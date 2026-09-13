import { describe, expect, test } from "bun:test";

import { getBuiltinTemplate } from "../connectors/templates.ts";
import { validateConnectorDraft } from "./connector-draft.ts";

const HTTP_TEMPLATE = getBuiltinTemplate("github");
if (!HTTP_TEMPLATE) throw new Error("github template fixture is missing");

describe("MCP connector draft validation", () => {
  test("requires the remote MCP endpoint", () => {
    const validation = validateConnectorDraft(
      {
        name: "Editorial MCP",
        slug: "editorial-mcp",
        driver: "mcp",
        environment: "prod",
        auth_type: "bearer",
        config: { mcp: { transport: "http", auth: { kind: "bearer" } } },
      },
      [],
    );
    expect(validation.ok).toBe(false);
    expect(validation.missing_fields).toContain("base_url");
  });

  test("rejects a template binding owned by another driver", () => {
    const validation = validateConnectorDraft(
      {
        name: "Editorial MCP",
        slug: "editorial-mcp",
        driver: "mcp",
        environment: "prod",
        auth_type: "bearer",
        base_url: "https://editorial.invalid/mcp",
        config: { mcp: { transport: "http", auth: { kind: "bearer" } } },
        template_slug: HTTP_TEMPLATE.slug,
      },
      [HTTP_TEMPLATE],
    );
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ path: "template_slug" }));
  });

  test("accepts a grounded bearer draft whose auth representations agree", () => {
    const validation = validateConnectorDraft(
      {
        name: "Editorial MCP",
        slug: "editorial-mcp",
        driver: "mcp",
        environment: "prod",
        auth_type: "bearer",
        base_url: "https://contentkit.example.test/mcp",
        config: { mcp: { transport: "http", auth: { kind: "bearer" } } },
      },
      [],
    );
    expect(validation).toMatchObject({ ok: true, missing_fields: [], errors: [] });
  });
});
