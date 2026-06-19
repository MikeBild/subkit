// Shared helpers for the llm flow tests. Each test file gets its own
// per-file disposable database via createTestDb and wires the mock LLM
// provider into the registry. A fresh tenant + a handful of skills +
// a connector + ingested doc chunks are seeded so the context pipeline
// has something real to pick up.

import {
  connectorDocumentChunks,
  connectorDocuments,
  connectors,
  skills,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { resetMockProvider } from "../mock-provider.ts";

export interface LlmTestCtx {
  testDb: TestDb;
  tenant_id: string;
  connector_id: string;
  skill_ids: {
    global: string;
    connector: string;
    workflow: string;
  };
  document_id: string;
  chunk_ids: string[];
  cleanup: () => Promise<void>;
}

export async function createLlmTestCtx(label: string): Promise<LlmTestCtx> {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  const testDb = await createTestDb(`llm_${label}`);

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `t-${label}`, display_name: `Test ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");

  const [connector] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenant.id,
      slug: `api-${label}`,
      display_name: `API ${label}`,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://jsonplaceholder.typicode.com",
      config: {},
    })
    .returning();
  if (!connector) throw new Error("seed connector failed");

  const inserted = await testDb.db
    .insert(skills)
    .values([
      {
        tenant_id: tenant.id,
        scope: "global",
        title: "prefer-get-for-lists",
        body: "Prefer GET for listing endpoints; avoid POST for retrieval.",
        examples: { examples: ["GET /users"], best_practices: [], pitfalls: [], doc_refs: [] },
        lifecycle: "active",
        version: 1,
      },
      {
        tenant_id: tenant.id,
        scope: "connector",
        connector_id: connector.id,
        title: "jsonplaceholder-users",
        body: "This connector exposes /users returning an array of {id,name,email}.",
        examples: {
          examples: ["GET /users?_limit=2"],
          best_practices: ["Respect _limit query"],
          pitfalls: [],
          doc_refs: [],
        },
        lifecycle: "active",
        version: 1,
      },
      {
        tenant_id: tenant.id,
        scope: "workflow",
        workflow_id: crypto.randomUUID(),
        title: "midnight-guard",
        body: "Never trigger page-roll mutations at midnight UTC.",
        examples: { examples: [], best_practices: [], pitfalls: [], doc_refs: [] },
        lifecycle: "active",
        version: 1,
      },
    ])
    .returning();

  const [globalSkill, connectorSkill, workflowSkill] = inserted;
  if (!globalSkill || !connectorSkill || !workflowSkill) {
    throw new Error("seed skills failed");
  }

  // Seed a connector document + a few chunks so doc search can produce
  // hits against the assembled prompt.
  const [doc] = await testDb.db
    .insert(connectorDocuments)
    .values({
      tenant_id: tenant.id,
      connector_id: connector.id,
      source_type: "markdown",
      source_uri: "https://docs.example/users.md",
      version: "1.0",
      bytes_total: 320,
      chunk_count: 3,
    })
    .returning();
  if (!doc) throw new Error("seed connector_document failed");

  const chunkRows = await testDb.db
    .insert(connectorDocumentChunks)
    .values([
      {
        tenant_id: tenant.id,
        connector_id: connector.id,
        document_id: doc.id,
        ordinal: 0,
        title: "GET /users",
        path: "/users",
        content:
          "List users. Returns an array of user objects with id, name, email fields. Supports _limit.",
        byte_size: 110,
        fingerprint: "fp-users-0",
      },
      {
        tenant_id: tenant.id,
        connector_id: connector.id,
        document_id: doc.id,
        ordinal: 1,
        title: "POST /users",
        path: "/users",
        content: "Create a user. Body must include name and email. Returns the created user.",
        byte_size: 100,
        fingerprint: "fp-users-1",
      },
      {
        tenant_id: tenant.id,
        connector_id: connector.id,
        document_id: doc.id,
        ordinal: 2,
        title: "GET /users/:id",
        path: "/users/{id}",
        content: "Fetch a single user by id. Returns 404 when the id does not exist.",
        byte_size: 100,
        fingerprint: "fp-users-2",
      },
    ])
    .returning();

  // tsv is a generated column so it populates itself on insert.

  const cleanup = async () => {
    await testDb.cleanup();
  };

  return {
    testDb,
    tenant_id: tenant.id,
    connector_id: connector.id,
    skill_ids: {
      global: globalSkill.id,
      connector: connectorSkill.id,
      workflow: workflowSkill.id,
    },
    document_id: doc.id,
    chunk_ids: chunkRows.map((r) => r.id),
    cleanup,
  };
}
