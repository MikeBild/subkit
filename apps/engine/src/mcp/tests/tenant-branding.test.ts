import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { auditLog } from "../../db/schema/audit.ts";
import { prepareTenantBrandingApprovalArgs } from "../tools/tenant-branding.ts";
import { replayHumanGrantedMcpCall } from "./approved-call-fixture.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("tenant-branding");
});

afterAll(async () => {
  await suite.cleanup();
});

function body(result: Record<string, unknown>) {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

const update = {
  revision: 0,
  display_name: "MCP workspace",
  subtitle: "Managed through MCP",
  palette: "indigo",
  logos: { light: { operation: "keep" }, dark: { operation: "keep" } },
};

describe("MCP tenant branding tools", () => {
  test("read tools are available to an authoring credential and mutations require admin mode", async () => {
    const { plaintext } = await suite.issueApiKey(["mcp:authoring"]);
    const client = await suite.connectWithApiKey(plaintext);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("get_tenant_branding");
    expect(names).toContain("get_tenant_branding_logo");
    expect(names).not.toContain("update_tenant_branding");
    expect(names).not.toContain("reset_tenant_branding");
  });

  test("the catalog declares every permission required by branding mutations", async () => {
    const { plaintext } = await suite.issueApiKey(["mcp:admin", "identity:write"]);
    const client = await suite.connectWithApiKey(plaintext);
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    const meta = tools.get("update_tenant_branding")?._meta as
      | { subkit?: { required_permissions?: unknown } }
      | undefined;
    expect(meta?.subkit?.required_permissions).toEqual(["identity:write", "settings:write"]);
  });

  test("a human-approved MCP update shares metadata with the read tool", async () => {
    const { plaintext } = await suite.issueApiKey([
      "mcp:admin",
      "identity:write",
      "settings:write",
    ]);
    const client = await suite.connectWithApiKey(plaintext);
    const pending = await client.callTool({ name: "update_tenant_branding", arguments: update });
    expect(body(pending)).toMatchObject({
      status: "needs_confirm",
      tool: "update_tenant_branding",
    });

    const saved = await replayHumanGrantedMcpCall(suite, client, pending);
    expect(saved.isError).toBeFalsy();
    expect(body(saved)).toMatchObject({
      revision: 1,
      configured: true,
      display_name: "MCP workspace",
      subtitle: "Managed through MCP",
      palette: "indigo",
      logos: { light: false, dark: false },
    });

    const rest = await fetch(`${suite.http.baseUrl}/v1/tenant/branding`, {
      headers: { authorization: `Bearer ${suite.http.apiKey}` },
    });
    expect(rest.status).toBe(200);
    expect((await rest.json()) as Record<string, unknown>).toMatchObject({
      revision: 1,
      display_name: "MCP workspace",
    });

    const read = await client.callTool({ name: "get_tenant_branding", arguments: {} });
    expect(read.isError).toBeFalsy();
    expect(body(read)).toMatchObject({ revision: 1, display_name: "MCP workspace" });

    const logo = await client.callTool({
      name: "get_tenant_branding_logo",
      arguments: { theme: "light", revision: 1 },
    });
    expect(logo.isError).toBe(true);
    expect(body(logo)).toMatchObject({ error_code: "not_found" });
  });

  test("an approved MCP logo upload is byte-identical through HTTP and both MCP themes, then reset", async () => {
    const { plaintext } = await suite.issueApiKey([
      "mcp:admin",
      "identity:write",
      "settings:write",
    ]);
    const client = await suite.connectWithApiKey(plaintext);
    const source = await sharp({
      create: { width: 20, height: 12, channels: 4, background: "#4f46e5" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const content_base64 = source.toString("base64");
    const approvalArgs = await prepareTenantBrandingApprovalArgs({
      ...update,
      revision: 1,
      logos: {
        light: { operation: "replace", mime_type: "image/jpeg", content_base64 },
        dark: { operation: "keep" },
      },
    });
    expect(approvalArgs.ok).toBe(true);
    if (!approvalArgs.ok) throw new Error(approvalArgs.message);
    const approvalLogo = (
      approvalArgs.args.logos as { light: { mime_type: string; content_base64: string } }
    ).light;
    expect(approvalLogo.mime_type).toBe("image/png");
    const approvalMetadata = await sharp(
      Buffer.from(approvalLogo.content_base64, "base64"),
    ).metadata();
    expect(approvalMetadata.format).toBe("png");
    expect(approvalMetadata.exif).toBeUndefined();
    expect(approvalMetadata.orientation).toBeUndefined();
    const pending = await client.callTool({
      name: "update_tenant_branding",
      arguments: {
        ...update,
        revision: 1,
        logos: {
          light: {
            operation: "replace",
            mime_type: "image/jpeg",
            content_base64,
          },
          dark: { operation: "keep" },
        },
      },
    });
    expect(JSON.stringify(body(pending))).not.toContain(content_base64);
    expect(body(pending)).toMatchObject({
      status: "needs_confirm",
      pending_output: {
        revision: 1,
        logos: {
          light: {
            operation: "replace",
            mime_type: "image/png",
            content_base64_length: approvalLogo.content_base64.length,
          },
        },
      },
    });
    const saved = await replayHumanGrantedMcpCall(suite, client, pending);
    expect(body(saved)).toMatchObject({ revision: 2, logos: { light: true, dark: false } });

    const httpLogo = await fetch(
      `${suite.http.baseUrl}/v1/tenant/branding/logo?theme=light&revision=2`,
      { headers: { authorization: `Bearer ${suite.http.apiKey}` } },
    );
    expect(httpLogo.status).toBe(200);
    expect(httpLogo.headers.get("content-type")).toBe("image/png");
    const httpBytes = Buffer.from(await httpLogo.arrayBuffer());
    expect(httpBytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    for (const theme of ["light", "dark"] as const) {
      const logo = await client.callTool({
        name: "get_tenant_branding_logo",
        arguments: { theme, revision: 2 },
      });
      expect(logo.isError).toBeFalsy();
      expect(Buffer.from(String(body(logo).content_base64), "base64")).toEqual(httpBytes);
    }

    const resetPending = await client.callTool({
      name: "reset_tenant_branding",
      arguments: { revision: 2 },
    });
    const reset = await replayHumanGrantedMcpCall(suite, client, resetPending);
    expect(body(reset)).toMatchObject({ configured: false, revision: 3 });
    const rest = await fetch(`${suite.http.baseUrl}/v1/tenant/branding`, {
      headers: { authorization: `Bearer ${suite.http.apiKey}` },
    });
    expect((await rest.json()) as Record<string, unknown>).toMatchObject({
      configured: false,
      revision: 3,
    });
    const audits = await suite.http.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.tenant_id, suite.http.tenantId));
    expect(JSON.stringify(audits)).not.toContain(content_base64);
  });

  test("accepts two valid logos when the MCP request exceeds four MiB", async () => {
    const { plaintext } = await suite.issueApiKey([
      "mcp:admin",
      "identity:write",
      "settings:write",
    ]);
    const client = await suite.connectWithApiKey(plaintext);
    const pixels = new Uint8Array(768 * 768 * 3);
    let state = 0x9e3779b9;
    for (let index = 0; index < pixels.length; index += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      pixels[index] = state >>> 24;
    }
    const source = await sharp(pixels, { raw: { width: 768, height: 768, channels: 3 } })
      .png()
      .toBuffer();
    expect(source.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    const content_base64 = source.toString("base64");
    expect(content_base64.length * 2).toBeGreaterThan(4 * 1024 * 1024);

    const pending = await client.callTool({
      name: "update_tenant_branding",
      arguments: {
        ...update,
        revision: 3,
        logos: {
          light: { operation: "replace", mime_type: "image/png", content_base64 },
          dark: { operation: "replace", mime_type: "image/png", content_base64 },
        },
      },
    });
    expect(pending.isError).toBeFalsy();
    expect(body(pending)).toMatchObject({
      status: "needs_confirm",
      tool: "update_tenant_branding",
    });
  });

  test("missing settings:write denies before an MCP approval is created", async () => {
    const { plaintext } = await suite.issueApiKey(["mcp:admin", "identity:write"]);
    const client = await suite.connectWithApiKey(plaintext);
    const result = await client.callTool({ name: "update_tenant_branding", arguments: update });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ error_code: "policy_denied" });
    expect(body(result).status).not.toBe("needs_confirm");
  });
});
