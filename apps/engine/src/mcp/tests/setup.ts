// MCP test scaffolding.
//
// Every MCP test piggy-backs on the existing HTTP test harness so we
// exercise the real Hono app, the real auth middleware, and the real
// Streamable HTTP transport. `startMcpTestSuite` returns:
//
//   - baseUrl + apiKey for hitting /mcp
//   - a ready-to-use MCP Client
//   - helpers for seeding tenant-scoped workflows, connectors, skills
//   - a disposal hook that closes the client, the http server, and the db
//
// Tests own per-suite labels so each test file gets its own throwaway
// database. The Client instance is created in `connect()` to keep the
// call-sites short.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { eq } from "drizzle-orm";
import { connectors, skills, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import type { WorkflowDef } from "../../workflows/types.ts";

export interface McpTestSuite {
  http: HttpTestServer;
  cleanup: () => Promise<void>;
  connect: () => Promise<Client>;
  seedWorkflow: (def: WorkflowDef & { slug: string }) => Promise<{ id: string; slug: string }>;
  seedConnector: (overrides?: Partial<ConnectorSeed>) => Promise<{ id: string }>;
  seedSkill: (overrides?: Partial<SkillSeed>) => Promise<{ id: string }>;
}

interface ConnectorSeed {
  slug: string;
  display_name: string;
  driver: string;
  environment: "dev" | "prod";
  base_url: string;
}

interface SkillSeed {
  title: string;
  body: string;
  examples: unknown[];
}

export async function startMcpTestSuite(label: string): Promise<McpTestSuite> {
  const http = await createHttpTestServer(`mcp-${label}`);

  // Track clients we open so we can clean them up.
  const openClients: Client[] = [];

  const connect = async (): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(new URL(`${http.baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${http.apiKey}` },
      },
    });
    const client = new Client({ name: "subkit-mcp-tests", version: "0.0.0" });
    await client.connect(transport as unknown as Transport);
    openClients.push(client);
    return client;
  };

  const seedWorkflow = async (
    def: WorkflowDef & { slug: string },
  ): Promise<{ id: string; slug: string }> => {
    const [wf] = await http.db
      .insert(workflows)
      .values({
        tenant_id: http.tenantId,
        slug: def.slug,
        name: def.name,
        lifecycle: "active",
      })
      .returning();
    if (!wf) throw new Error("seed workflow failed");
    const [v] = await http.db
      .insert(workflowVersions)
      .values({
        tenant_id: http.tenantId,
        workflow_id: wf.id,
        version: 1,
        dag: def,
      })
      .returning();
    if (!v) throw new Error("seed workflow_versions failed");
    await http.db
      .update(workflows)
      .set({ current_version_id: v.id })
      .where(eq(workflows.id, wf.id));
    return { id: wf.id, slug: def.slug };
  };

  const seedConnector = async (overrides: Partial<ConnectorSeed> = {}): Promise<{ id: string }> => {
    const [row] = await http.db
      .insert(connectors)
      .values({
        tenant_id: http.tenantId,
        slug: overrides.slug ?? `cn-${Math.random().toString(36).slice(2, 8)}`,
        display_name: overrides.display_name ?? "Test Connector",
        driver: overrides.driver ?? "http",
        environment: overrides.environment ?? "dev",
        auth_type: "none",
        base_url: overrides.base_url ?? "https://example.test",
        config: {},
      })
      .returning();
    if (!row) throw new Error("seed connector failed");
    return { id: row.id };
  };

  const seedSkill = async (overrides: Partial<SkillSeed> = {}): Promise<{ id: string }> => {
    const [row] = await http.db
      .insert(skills)
      .values({
        tenant_id: http.tenantId,
        scope: "global",
        title: overrides.title ?? "How to bake bread",
        body: overrides.body ?? "Mix flour, water, salt. Bake.",
        examples: overrides.examples ?? ["example one", "example two"],
        lifecycle: "active",
        version: 1,
      })
      .returning();
    if (!row) throw new Error("seed skill failed");
    return { id: row.id };
  };

  const cleanup = async (): Promise<void> => {
    for (const c of openClients) {
      try {
        await c.close();
      } catch {
        // ignore
      }
    }
    await http.cleanup();
  };

  return { http, cleanup, connect, seedWorkflow, seedConnector, seedSkill };
}
