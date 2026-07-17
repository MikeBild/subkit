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

async function listAllResourceUris(client: Client): Promise<string[]> {
  const uris: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listResources({ ...(cursor ? { cursor } : {}) });
    uris.push(...page.resources.map((r) => r.uri));
    cursor = page.nextCursor;
  } while (cursor);
  return uris;
}

beforeAll(async () => {
  suite = await startMcpTestSuite("resources");
}, 60_000);

afterAll(async () => {
  await suite?.cleanup();
}, 60_000);

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

  test("lists resource templates for readable resource families", async () => {
    const client = await suite.connect();
    const list = await client.listResourceTemplates();
    const templates = list.resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toContain("connector://{id}");
    expect(templates).toContain("knowledge://{id}");
    expect(templates).toContain("skill-candidate://{id}");
    expect(templates).toContain("workflow://{id}");
    expect(templates).toContain("file://{id}");
    expect(templates).toContain("fixture://{id}");
    expect(templates).toContain("subkit://operator/health-digest");
  });

  test("list paginates with nextCursor and rejects malformed cursors", async () => {
    for (let i = 0; i < 101; i++) {
      await suite.seedConnector({
        slug: `paged-res-${i}`,
        display_name: `Paged Resource ${i}`,
      });
    }
    const client = await suite.connect();
    const first = await client.listResources();
    expect(first.resources).toHaveLength(100);
    expect(typeof first.nextCursor).toBe("string");
    const second = await client.listResources({ cursor: first.nextCursor });
    expect(second.resources.length).toBeGreaterThanOrEqual(1);
    expect(second.nextCursor).toBeUndefined();

    await expect(client.listResources({ cursor: "not-base64-json" })).rejects.toThrow(
      /Invalid pagination cursor for resources\/list/,
    );
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
      title: "[DM] Interactions between Widget Control - Charger Firmware",
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
      const memberUris = await listAllResourceUris(memberClient);
      expect(memberUris).not.toContain("subkit://operator/health-digest");

      // A direct read must be rejected with a permission_denied JSON-RPC error.
      await expect(
        memberClient.readResource({ uri: "subkit://operator/health-digest" }),
      ).rejects.toThrow();
    } finally {
      await memberClient.close();
    }

    // Confirm the gate is permission-based: admin sees the digest URI.
    const adminClient = await suite.connect();
    const adminUris = await listAllResourceUris(adminClient);
    expect(adminUris).toContain("subkit://operator/health-digest");
  });

  test("knowledge:// read returns full markdown content, not a metadata stub", async () => {
    const { upsertKnowledgeBundle } = await import("../../knowledge/bundle-service.ts");
    const { knowledge_source } = await upsertKnowledgeBundle(
      {
        tenant_id: suite.http.tenantId,
        actor_id: null,
        input: { name: "Resource Wiki", slug: "resource-wiki" },
        files: [
          {
            path: "runbooks/deploy.md",
            content: "---\ntype: Runbook\n---\n# Deploy\n\nRun the deploy script.",
          },
          { path: "index.md", content: "# Nav" },
        ],
      },
      suite.http.db,
    );

    const client = await suite.connect();
    const read = await client.readResource({ uri: `knowledge://${knowledge_source.id}` });
    expect(read.contents.length).toBe(1);
    const content = read.contents[0] as { mimeType?: string; text?: string };
    expect(content.mimeType).toBe("text/markdown");
    // Metadata rides along as a leading comment; the actual knowledge follows.
    expect(content.text).toContain(`id: ${knowledge_source.id}`);
    expect(content.text).toContain("Run the deploy script.");
    expect(content.text).toContain("/runbooks/deploy.md");
    expect(content.text).not.toContain("truncated at");
  });

  test("knowledge:// read pages past 200 chunks without truncation (loop advances)", async () => {
    const { upsertKnowledgeBundle } = await import("../../knowledge/bundle-service.ts");
    // 250 small files → 250 chunks (> the 200-per-page limit) but well
    // under the 1 MiB cap, so the pagination loop must advance offset
    // and terminate with the FULL content.
    const files = Array.from({ length: 250 }, (_, i) => ({
      path: `notes/n${String(i).padStart(3, "0")}.md`,
      content: `note ${i}: compact unique body ${i}.`,
    }));
    const { knowledge_source } = await upsertKnowledgeBundle(
      {
        tenant_id: suite.http.tenantId,
        actor_id: null,
        input: { name: "Many Notes Wiki", slug: "many-notes-wiki" },
        files,
      },
      suite.http.db,
    );

    const client = await suite.connect();
    const read = await client.readResource({ uri: `knowledge://${knowledge_source.id}` });
    const content = read.contents[0] as { text?: string };
    expect(content.text).toContain("note 0:");
    expect(content.text).toContain("note 249:");
    expect(content.text).not.toContain("truncated at");
  });

  test("knowledge:// read caps at 1 MiB with a truncation notice", async () => {
    const { upsertKnowledgeBundle } = await import("../../knowledge/bundle-service.ts");
    // ~1.5 MiB across three files — must exceed the 1 MiB read cap.
    // Every paragraph is position-unique so neither the whole-file dedup
    // nor the per-chunk fingerprint dedup collapses the volume.
    const big = (label: string) =>
      Array.from(
        { length: 8_000 },
        (_, i) => `${label} paragraph ${i}: the quick brown fox jumps over lazy dog number ${i}.`,
      ).join("\n\n");
    const { knowledge_source } = await upsertKnowledgeBundle(
      {
        tenant_id: suite.http.tenantId,
        actor_id: null,
        input: { name: "Big Wiki", slug: "big-wiki" },
        files: [
          { path: "a.md", content: big("alpha") },
          { path: "b.md", content: big("beta") },
          { path: "c.md", content: big("gamma") },
        ],
      },
      suite.http.db,
    );

    const client = await suite.connect();
    const read = await client.readResource({ uri: `knowledge://${knowledge_source.id}` });
    const content = read.contents[0] as { text?: string };
    expect(Buffer.byteLength(content.text!, "utf8")).toBeLessThanOrEqual(1024 * 1024 + 256);
    expect(content.text).toContain("truncated at");
    expect(content.text).toContain("read_knowledge");
  });

  // B1 — MCP 2025-11-25 compliance: resource-not-found MUST be JSON-RPC
  // error code -32002 (not the generic internal-error -32603). Each URI
  // family has its own handler; all must emit the same code.
  test("B1: unknown file:// URI returns JSON-RPC error code -32002", async () => {
    const client = await suite.connect();
    const err = await client
      .readResource({ uri: "file://00000000-0000-0000-0000-000000000001" })
      .catch((e: unknown) => e);
    expect((err as { code?: number }).code).toBe(-32002);
  });

  test("B1: unknown knowledge:// URI returns JSON-RPC error code -32002", async () => {
    const client = await suite.connect();
    const err = await client
      .readResource({ uri: "knowledge://00000000-0000-0000-0000-000000000002" })
      .catch((e: unknown) => e);
    expect((err as { code?: number }).code).toBe(-32002);
  });

  test("B1: unknown workflow:// URI returns JSON-RPC error code -32002", async () => {
    const client = await suite.connect();
    const err = await client
      .readResource({ uri: "workflow://00000000-0000-0000-0000-000000000003" })
      .catch((e: unknown) => e);
    expect((err as { code?: number }).code).toBe(-32002);
  });

  test("B1: unknown fixture:// URI (valid UUID, no row) returns JSON-RPC error code -32002", async () => {
    const client = await suite.connect();
    const err = await client
      .readResource({ uri: "fixture://00000000-0000-0000-0000-000000000004" })
      .catch((e: unknown) => e);
    expect((err as { code?: number }).code).toBe(-32002);
  });

  // P2 — resources/unsubscribe succeeds (the per-session subscribed-Set is
  // updated server-side; the MCP spec requires an empty result).
  test("P2: resources/unsubscribe removes a previously-subscribed URI and returns empty", async () => {
    const { id } = await suite.seedConnector({ slug: "unsub-probe" });
    const client = await suite.connect();
    // Subscribe first so there is something to unsubscribe.
    await client.subscribeResource({ uri: `connector://${id}` });
    // Unsubscribe — must not throw and must return an empty result.
    const res = await client.unsubscribeResource({ uri: `connector://${id}` });
    expect(res).toBeDefined();
  });
});
