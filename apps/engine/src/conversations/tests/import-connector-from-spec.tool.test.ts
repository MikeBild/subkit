import { describe, expect, test } from "bun:test";
import { importConnectorFromSpecTool } from "../tools/import-connector-from-spec.ts";

// Smoke tests for the conversation tool — no DB or draft state needed.
// The tool's execute() is passed a null context because it only uses
// stateless parsers + template matching.

// biome-ignore lint/suspicious/noExplicitAny: minimal stub for stateless tool
const nullCtx = null as any;

describe("importConnectorFromSpecTool", () => {
  test("tool name is import_connector_from_spec", () => {
    expect(importConnectorFromSpecTool.name).toBe("import_connector_from_spec");
  });

  test("curl command with GitHub URL → template_match for github", async () => {
    // The tool strips the path from the curl URL (base URL = protocol+host) and
    // matches against url_pattern. GitHub's pattern matches the host-only URL;
    // Stripe's pattern requires /v1 so it doesn't match on base-URL-only input.
    const result = await importConnectorFromSpecTool.execute(nullCtx, {
      source: "curl",
      content:
        "curl -H 'Authorization: Bearer ghp_xxx' https://api.github.com/repos/owner/repo/issues",
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      template_match: { slug: string } | null;
      draft: { driver: string };
    };
    expect(data.template_match).not.toBeNull();
    expect(data.template_match!.slug).toMatch(/github/);
    expect(data.draft.driver).toBe("http");
  });

  test("curl command with unknown domain → manual fallback (template_match=null)", async () => {
    const result = await importConnectorFromSpecTool.execute(nullCtx, {
      source: "curl",
      content:
        "curl -H 'Authorization: Bearer token' https://unknown-domain-xyz-12345.example.com/api/v1/resource",
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { template_match: null; draft: { driver: string } };
    expect(data.template_match).toBeNull();
    expect(data.draft.driver).toBe("http");
  });

  test("curl with bearer auth → draft auth_type bearer", async () => {
    const result = await importConnectorFromSpecTool.execute(nullCtx, {
      source: "curl",
      content:
        "curl -H 'Authorization: Bearer token' https://unknown-domain-xyz-12345.example.com/api",
      environment: "dev",
    });
    const data = result.data as { draft: { auth_type: string } };
    expect(data.draft.auth_type).toBe("bearer");
  });

  test("result includes recommended_next array", async () => {
    const result = await importConnectorFromSpecTool.execute(nullCtx, {
      source: "curl",
      content: "curl https://api.stripe.com/v1/charges",
      environment: "dev",
    });
    const data = result.data as { recommended_next: string[] };
    expect(Array.isArray(data.recommended_next)).toBe(true);
    expect(data.recommended_next.length).toBeGreaterThan(0);
  });

  test("curl with explicit -X POST method is captured", async () => {
    const result = await importConnectorFromSpecTool.execute(nullCtx, {
      source: "curl",
      content: 'curl -X POST -d \'{"name":"Alice"}\' https://api.stripe.com/v1/customers',
      environment: "dev",
    });
    expect(result.ok).toBe(true);
  });

  test("invalid source throws via schema validation", async () => {
    await expect(
      importConnectorFromSpecTool.execute(nullCtx, {
        source: "xml",
        content: "<root/>",
        environment: "dev",
      }),
    ).rejects.toThrow();
  });
});
