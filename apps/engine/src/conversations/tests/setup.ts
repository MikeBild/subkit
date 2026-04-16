// Conversation test scaffolding. Each test file gets its own
// disposable database, a seeded tenant + connector + skills + docs,
// and the mock LLM provider wired in.

import {
  connectorDocumentChunks,
  connectorDocuments,
  connectors,
  skills,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";

export interface ConversationTestCtx {
  testDb: TestDb;
  tenant_id: string;
  user_id: string;
  connector_id: string;
  cleanup: () => Promise<void>;
}

export async function createConversationTestCtx(label: string): Promise<ConversationTestCtx> {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  const testDb = await createTestDb(`conv_${label}`);

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `t-${label}`, display_name: `Test ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");

  const [user] = await testDb.db
    .insert(users)
    .values({
      tenant_id: tenant.id,
      email: `admin-${label}@test.local`,
      role: "admin",
    })
    .returning();
  if (!user) throw new Error("seed user failed");

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

  await testDb.db
    .insert(skills)
    .values([
      {
        tenant_id: tenant.id,
        scope: "global",
        title: "prefer-get-for-lists",
        body: "Prefer GET for listing endpoints.",
        examples: { examples: [], best_practices: [], pitfalls: [], doc_refs: [] },
        lifecycle: "active",
        version: 1,
      },
      {
        tenant_id: tenant.id,
        scope: "connector",
        connector_id: connector.id,
        title: "jsonplaceholder-users",
        body: "The users endpoint returns an array of {id,name,email}.",
        examples: { examples: [], best_practices: [], pitfalls: [], doc_refs: [] },
        lifecycle: "active",
        version: 1,
      },
    ])
    .returning();

  const [doc] = await testDb.db
    .insert(connectorDocuments)
    .values({
      tenant_id: tenant.id,
      connector_id: connector.id,
      source_type: "markdown",
      source_uri: "https://docs.example/users.md",
      version: "1.0",
      bytes_total: 200,
      chunk_count: 1,
    })
    .returning();
  if (!doc) throw new Error("seed document failed");

  await testDb.db
    .insert(connectorDocumentChunks)
    .values([
      {
        tenant_id: tenant.id,
        connector_id: connector.id,
        document_id: doc.id,
        ordinal: 0,
        title: "GET /users",
        path: "/users",
        content: "List users. Returns an array of user objects with id, name, email fields.",
        byte_size: 100,
        fingerprint: "fp-users-0",
      },
    ])
    .returning();

  return {
    testDb,
    tenant_id: tenant.id,
    user_id: user.id,
    connector_id: connector.id,
    cleanup: async () => {
      await testDb.cleanup();
    },
  };
}
