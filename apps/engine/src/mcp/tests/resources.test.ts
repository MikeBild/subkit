import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { apiKeys, executionFixtures, executions, users } from "../../db/schema/index.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function mintKey(): { plaintext: string; prefix: string; hash: string } {
  // Deterministic literal — randomBytes is banned in *.test.ts by the
  // determinism gate. One member key per file, inserted into this file's own
  // isolated test DB, so a fixed value is unique where it matters.
  const plaintext = "wf_live_negres_member_0001";
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("resources");
});

afterAll(async () => {
  await suite.cleanup();
});

describe("mcp resources", () => {
  test("list + read connector resource", async () => {
    const { id } = await suite.seedConnector({
      slug: "res-probe",
      display_name: "Resource Probe",
      driver: "http",
      base_url: "https://api.probe.test",
    });
    const client = await suite.connect();
    const list = await client.listResources();
    const uris = list.resources.map((r) => r.uri);
    expect(uris).toContain(`connector://${id}`);

    const read = await client.readResource({ uri: `connector://${id}` });
    expect(read.contents.length).toBe(1);
    const content = read.contents[0] as { mimeType?: string; text?: string };
    expect(content.mimeType).toBe("application/json");
    const body = JSON.parse(content.text!) as {
      id: string;
      driver: string;
      base_url: string;
    };
    expect(body.id).toBe(id);
    expect(body.driver).toBe("http");
    expect(body.base_url).toBe("https://api.probe.test");
  });

  // Regression guard for the MCP round-trip failure: when a `wf.*`
  // tool result is offloaded the envelope hands the client a
  // `fixture://<id>` URI, and the client MUST be able to read it back via
  // `resources/read`. Before this test the read path threw
  // `-32603: unsupported uri: fixture://...` and the offloaded body was
  // unreachable from outside the conversation surface.
  test("read fixture resource (offloaded wf.* payload round-trip)", async () => {
    const payload = {
      page_id: "87263947",
      title: "[DM] Interactions between Sifinity Control - Charger Firmware",
      body_size: 279894,
      excerpt: "x".repeat(20_000),
    };
    const [exec] = await suite.http.db
      .insert(executions)
      .values({
        tenant_id: suite.http.tenantId,
        status: "succeeded",
        request_source: "mcp",
        execution_mode: "dev",
        source_kind: "draft",
      })
      .returning();
    if (!exec) throw new Error("seed execution failed");
    const [fix] = await suite.http.db
      .insert(executionFixtures)
      .values({
        tenant_id: suite.http.tenantId,
        kind: "offload",
        execution_id: exec.id,
        body: payload,
        byte_size: JSON.stringify(payload).length,
      })
      .returning({ id: executionFixtures.id });
    if (!fix) throw new Error("seed execution_fixtures failed");

    const client = await suite.connect();
    const uri = `fixture://${fix.id}`;
    const read = await client.readResource({ uri });
    expect(read.contents.length).toBe(1);
    const content = read.contents[0] as { mimeType?: string; text?: string };
    expect(content.mimeType).toBe("application/json");
    const body = JSON.parse(content.text!) as typeof payload;
    expect(body.page_id).toBe(payload.page_id);
    expect(body.title).toBe(payload.title);
    expect(body.excerpt.length).toBe(payload.excerpt.length);
  });

  test("read fixture rejects malformed id", async () => {
    const client = await suite.connect();
    await expect(client.readResource({ uri: "fixture://not-a-uuid" })).rejects.toThrow(
      /invalid fixture id/i,
    );
  });

  test("read fixture returns not_found for unknown id", async () => {
    const client = await suite.connect();
    await expect(
      client.readResource({ uri: "fixture://00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(/fixture not found/i);
  });

  test("operator health digest is neither enumerated nor readable without stats:read", async () => {
    // Insert a member-role user. The member role excludes stats:read
    // (see apps/engine/src/rbac/seed.ts memberPermissionFilter), so the
    // digest must not appear in listResources and readResource must throw.
    const [memberUser] = await suite.http.db
      .insert(users)
      .values({
        tenant_id: suite.http.tenantId,
        email: "member-resources@test.local",
        role: "member",
      })
      .returning();
    if (!memberUser) throw new Error("seed member user failed");

    const memberKey = mintKey();
    await suite.http.db.insert(apiKeys).values({
      tenant_id: suite.http.tenantId,
      user_id: memberUser.id,
      prefix: memberKey.prefix,
      token_sha256: memberKey.hash,
      scopes: ["*"],
    });

    const transport = new StreamableHTTPClientTransport(new URL(`${suite.http.baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${memberKey.plaintext}` },
      },
    });
    const memberClient = new Client({ name: "subkit-mcp-tests-member-res", version: "0.0.0" });
    await memberClient.connect(transport as unknown as Transport);

    try {
      // The digest URI must not appear in the member's resource list.
      const list = await memberClient.listResources();
      expect(list.resources.map((r) => r.uri)).not.toContain("subkit://operator/health-digest");

      // A direct read must be rejected with a permission_denied JSON-RPC error.
      await expect(
        memberClient.readResource({ uri: "subkit://operator/health-digest" }),
      ).rejects.toThrow();
    } finally {
      await memberClient.close();
    }

    // Confirm the gate is permission-based: admin sees the digest URI.
    const adminClient = await suite.connect();
    const adminList = await adminClient.listResources();
    expect(adminList.resources.map((r) => r.uri)).toContain("subkit://operator/health-digest");
  });
});
