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
        base_url: "https://editorial.example.test/mcp",
        config: { mcp: { transport: "http", auth: { kind: "bearer" } } },
      },
      [],
    );
    expect(validation).toMatchObject({ ok: true, missing_fields: [], errors: [] });
  });
});

describe("local MCP connector drafts", () => {
  const stdioDraft = {
    name: "Docker MCP",
    slug: "docker-mcp",
    driver: "mcp" as const,
    environment: "dev" as const,
    auth_type: "none" as const,
    config: {
      mcp: {
        transport: "stdio",
        command: "docker",
        args: ["mcp", "gateway", "run"],
        auth: { kind: "none" },
      },
    },
  };

  test("a stdio draft needs a command, not a base_url", () => {
    const validation = validateConnectorDraft(stdioDraft, []);
    expect(validation.missing_fields).not.toContain("base_url");
    const withoutCommand = validateConnectorDraft(
      { ...stdioDraft, config: { mcp: { transport: "stdio", auth: { kind: "none" } } } },
      [],
    );
    expect(withoutCommand.missing_fields).toContain("config.mcp.command");
  });

  test("a stdio draft rejects a base_url", () => {
    const validation = validateConnectorDraft(
      { ...stdioDraft, base_url: "http://localhost:8931/mcp" },
      [],
    );
    expect(validation.errors).toContainEqual(expect.objectContaining({ path: "base_url" }));
  });

  test.each([
    "http://localhost:8931/mcp",
    "https://127.0.0.1:8443/mcp",
    "http://[::1]:3000/mcp",
    "http://host.docker.internal:8931/mcp",
  ])("the local address %s is not treated as a placeholder", (base_url) => {
    const validation = validateConnectorDraft(
      {
        name: "Local MCP",
        slug: "local-mcp",
        driver: "mcp",
        environment: "dev",
        auth_type: "none",
        base_url,
        config: { mcp: { transport: "http", auth: { kind: "none" } } },
      },
      [],
    );
    expect(validation.errors.filter((issue) => issue.path === "base_url")).toEqual([]);
  });

  test("the placeholder message no longer names localhost", () => {
    const validation = validateConnectorDraft(
      {
        name: "Placeholder",
        slug: "placeholder",
        driver: "mcp",
        environment: "dev",
        auth_type: "none",
        base_url: "https://your-host.example.com/mcp",
        config: { mcp: { transport: "http", auth: { kind: "none" } } },
      },
      [],
    );
    const message = validation.errors.find((issue) => issue.path === "base_url")?.message ?? "";
    expect(message).toContain("placeholder");
    expect(message).not.toMatch(/localhost|127\.0\.0\.1/);
  });
});
