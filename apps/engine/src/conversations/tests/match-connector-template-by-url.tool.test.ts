import { describe, expect, test } from "bun:test";
import { matchConnectorTemplateByUrlTool } from "../tools/match-connector-template-by-url.ts";

// Smoke tests for the conversation tool — no DB, no draft state needed.
// The tool's execute() is passed a null context because it uses only
// the stateless URL-matching logic from template-url-match.ts.

// biome-ignore lint/suspicious/noExplicitAny: minimal stub for stateless tool
const nullCtx = null as any;

describe("matchConnectorTemplateByUrlTool", () => {
  test("tool name is match_connector_template_by_url", () => {
    expect(matchConnectorTemplateByUrlTool.name).toBe("match_connector_template_by_url");
  });

  test("Stripe URL returns matched=true and slug=stripe", async () => {
    const result = await matchConnectorTemplateByUrlTool.execute(nullCtx, {
      url: "https://api.stripe.com/v1/customers",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { matched: boolean; matches: Array<{ slug: string }> };
    expect(data.matched).toBe(true);
    expect(data.matches[0]?.slug).toBe("stripe");
  });

  test("invalid URL returns matched=false", async () => {
    const result = await matchConnectorTemplateByUrlTool.execute(nullCtx, {
      url: "not-a-url",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { matched: boolean };
    expect(data.matched).toBe(false);
  });

  test("limit is respected", async () => {
    const result = await matchConnectorTemplateByUrlTool.execute(nullCtx, {
      url: "https://api.stripe.com/v1/charges",
      limit: 1,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { matches: unknown[] };
    expect(data.matches.length).toBeLessThanOrEqual(1);
  });

  test("result includes setup_instructions and credential_hints", async () => {
    const result = await matchConnectorTemplateByUrlTool.execute(nullCtx, {
      url: "https://api.stripe.com/v1/charges",
      limit: 1,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      matches: Array<{ setup_instructions: string; credential_hints: unknown[] }>;
    };
    expect(data.matches[0]?.setup_instructions).toBeTruthy();
    expect(Array.isArray(data.matches[0]?.credential_hints)).toBe(true);
  });

  test("url is echoed back in the result", async () => {
    const url = "https://api.stripe.com/v1/invoices";
    const result = await matchConnectorTemplateByUrlTool.execute(nullCtx, { url, limit: 3 });
    const data = result.data as { url: string };
    expect(data.url).toBe(url);
  });
});
