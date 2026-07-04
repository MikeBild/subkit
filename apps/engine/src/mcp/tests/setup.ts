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
import {
  apiKeys,
  connectors,
  executionSteps,
  executions,
  skills,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { generateKey } from "../../identity/api-key.ts";
import type { WorkflowDef } from "../../workflows/types.ts";

export interface McpTestSuite {
  http: HttpTestServer;
  cleanup: () => Promise<void>;
  connect: () => Promise<Client>;
  connectWithApiKey: (apiKey: string) => Promise<Client>;
  issueApiKey: (scopes: string[]) => Promise<{ plaintext: string }>;
  issueApiKeyForTenant: (
    tenantId: string,
    userId: string,
    scopes: string[],
  ) => Promise<{ plaintext: string }>;
  /**
   * Connect a client that advertises the MCP async-Tasks (SEP-1686)
   * capability — `tasks/get|result|list|cancel` plus task-augmented
   * `tools/call`. Required to exercise the `CreateTaskResult` path.
   */
  connectTasks: () => Promise<Client>;
  connectTasksWithApiKey: (apiKey: string) => Promise<Client>;
  seedWorkflow: (def: WorkflowDef & { slug: string }) => Promise<{ id: string; slug: string }>;
  seedConnector: (overrides?: Partial<ConnectorSeed>) => Promise<{ id: string }>;
  seedSkill: (overrides?: Partial<SkillSeed>) => Promise<{ id: string }>;
  seedExecution: (opts?: SeedExecutionOpts) => Promise<{ execution_id: string }>;
}

export interface StartMcpTestSuiteOptions {
  /**
   * Start pg-boss against the test DB and register the
   * `conversation.run-turn` worker. Required for any suite that drives
   * the conversation tool cluster — those tools enqueue a background
   * turn and the worker runs the model loop.
   */
  withQueue?: boolean;
}

interface SeedExecutionStep {
  step_key: string;
  kind?: string;
  status?: string;
  duration_ms?: number;
  output_preview?: unknown;
}

interface SeedExecutionOpts {
  status?: "succeeded" | "failed";
  steps?: SeedExecutionStep[];
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
  arguments: unknown[];
}

export async function startMcpTestSuite(
  label: string,
  opts: StartMcpTestSuiteOptions = {},
): Promise<McpTestSuite> {
  const http = await createHttpTestServer(`mcp-${label}`);

  // Optional pg-boss + conversation-run-turn worker — the conversation
  // tool cluster enqueues a background turn (MCP async Tasks, SEP-1686),
  // so a suite exercising those tools must run the worker.
  let bossCleanup: (() => Promise<void>) | null = null;
  if (opts.withQueue) {
    const { startBoss, stopBoss } = await import("../../queue/boss.ts");
    const { registerConversationRunTurnHandler } = await import(
      "../../queue/handlers/conversation-run-turn.ts"
    );
    const boss = await startBoss({ connectionString: http.testDb.url });
    await registerConversationRunTurnHandler({ boss, db: http.db });
    bossCleanup = async () => {
      await stopBoss(5_000);
    };
  }

  // Track clients we open so we can clean them up.
  const openClients: Client[] = [];

  const connect = async (): Promise<Client> => {
    return connectWithApiKey(http.apiKey);
  };

  const connectWithApiKey = async (apiKey: string): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(new URL(`${http.baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${apiKey}` },
      },
    });
    const client = new Client({ name: "subkit-mcp-tests", version: "0.0.0" });
    await client.connect(transport as unknown as Transport);
    openClients.push(client);
    return client;
  };

  const connectTasks = async (): Promise<Client> => {
    return connectTasksWithApiKey(http.apiKey);
  };

  const connectTasksWithApiKey = async (apiKey: string): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(new URL(`${http.baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${apiKey}` },
      },
    });
    const client = new Client(
      { name: "subkit-mcp-tests-tasks", version: "0.0.0" },
      { capabilities: { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } } },
    );
    await client.connect(transport as unknown as Transport);
    openClients.push(client);
    return client;
  };

  const issueApiKey = async (scopes: string[]): Promise<{ plaintext: string }> => {
    return issueApiKeyForTenant(http.tenantId, http.userId, scopes);
  };

  const issueApiKeyForTenant = async (
    tenantId: string,
    userId: string,
    scopes: string[],
  ): Promise<{ plaintext: string }> => {
    const key = generateKey();
    const [row] = await http.db
      .insert(apiKeys)
      .values({
        tenant_id: tenantId,
        user_id: userId,
        prefix: key.prefix,
        token_sha256: key.hash,
        scopes,
      })
      .returning({ id: apiKeys.id });
    if (!row) throw new Error("seed api key failed");
    return { plaintext: key.plaintext };
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
        arguments: overrides.arguments ?? [],
        lifecycle: "active",
        version: 1,
      })
      .returning();
    if (!row) throw new Error("seed skill failed");
    return { id: row.id };
  };

  const seedExecution = async (opts: SeedExecutionOpts = {}): Promise<{ execution_id: string }> => {
    const [exec] = await http.db
      .insert(executions)
      .values({
        tenant_id: http.tenantId,
        status: opts.status ?? "succeeded",
        source_kind: "draft",
        request_source: "test",
        execution_mode: "dev",
      })
      .returning();
    if (!exec) throw new Error("seed execution failed");
    const steps = opts.steps ?? [
      { step_key: "step_one", kind: "request", status: "succeeded", duration_ms: 12 },
    ];
    let idx = 0;
    for (const s of steps) {
      await http.db.insert(executionSteps).values({
        tenant_id: http.tenantId,
        execution_id: exec.id,
        step_key: s.step_key,
        step_index: idx++,
        kind: s.kind ?? "request",
        status: s.status ?? "succeeded",
        duration_ms: s.duration_ms ?? 0,
        ...(s.output_preview !== undefined ? { output_preview: s.output_preview } : {}),
      });
    }
    return { execution_id: exec.id };
  };

  const cleanup = async (): Promise<void> => {
    for (const c of openClients) {
      try {
        await c.close();
      } catch {
        // ignore
      }
    }
    if (bossCleanup) {
      try {
        await bossCleanup();
      } catch {
        // ignore
      }
    }
    await http.cleanup();
  };

  return {
    http,
    cleanup,
    connect,
    connectWithApiKey,
    issueApiKey,
    issueApiKeyForTenant,
    connectTasks,
    connectTasksWithApiKey,
    seedWorkflow,
    seedConnector,
    seedSkill,
    seedExecution,
  };
}
