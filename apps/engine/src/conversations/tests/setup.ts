// Conversation test scaffolding. Each test file gets its own
// disposable database, a seeded tenant + connector + skills + docs,
// and the mock LLM provider wired in.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getConfig, loadConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
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
import { registerConversationAbort, unregisterConversationAbort } from "../abort.ts";
import { type AnswerActor, MODEL_RELAYED_ANSWER } from "../answer-actor.ts";
import * as svc from "../service.ts";

/**
 * A unit test stands in for a person at a keyboard: `answer_actor` defaults to
 * the acting user, answering through the chat channel. Tests that assert the
 * relay contract (a model-driven resume grants nothing) pass `MODEL_RELAYED_ANSWER`
 * explicitly. The default lives HERE and nowhere in `src/` — every production
 * surface must state the channel itself or fail to compile.
 */
function testAnswerActor(actor_id: string | null | undefined, override?: AnswerActor): AnswerActor {
  if (override) return override;
  return actor_id ? { kind: "human", user_id: actor_id, via: "chat" } : MODEL_RELAYED_ANSWER;
}

// ── Test helpers: create / append + drive the turn in one call ───────────────
//
// Production `createConversation` / `appendUserMessage` STOP after
// persisting the user message row — the model loop runs separately via
// `runConversationTurn` (inline on the HTTP/SSE route, or in the
// `conversation.run-turn` worker for the MCP async-Tasks path). Most
// unit tests want the old "call once, get the turn outcome" ergonomics;
// these helpers compose the split + register an AbortController so the
// test reads the `ConversationTurnOutcome` directly.

/** create the conversation, persist the first message, run the turn. */
export async function createConversationWithTurn(
  params: svc.CreateConversationParams &
    Pick<svc.RunConversationTurnParams, "onEvent" | "runtime_context" | "principal"> & {
      answer_actor?: AnswerActor;
    },
  db: Db,
): Promise<svc.ConversationTurnOutcome> {
  const { onEvent, runtime_context, answer_actor, principal, ...createParams } = params;
  const created = await svc.createConversation(createParams, db);
  if (!created.initial_message) {
    return { conversation: created.conversation, result: { events: [], status: "active" } };
  }
  const ctrl = registerConversationAbort(created.conversation.tenant_id, created.conversation.id);
  try {
    return await svc.runConversationTurn(
      {
        tenant_id: created.conversation.tenant_id,
        conversation_id: created.conversation.id,
        actor_id: createParams.actor_id ?? null,
        user_message: created.initial_message,
        answer_actor: testAnswerActor(createParams.actor_id, answer_actor),
        user_memory: created.user_memory,
        turn_abort_ctrl: ctrl,
        ...(createParams.permission_mode ? { permission_mode: createParams.permission_mode } : {}),
        ...(onEvent ? { onEvent } : {}),
        ...(runtime_context ? { runtime_context } : {}),
        ...(principal !== undefined ? { principal } : {}),
      },
      db,
    );
  } finally {
    unregisterConversationAbort(created.conversation.tenant_id, created.conversation.id, ctrl);
  }
}

/** resolve an elicitation + resume the loop, with a registered abort controller. */
export async function respondElicitationForTest(
  params: Omit<svc.RespondElicitationParams, "turn_abort_ctrl" | "answer_actor"> & {
    answer_actor?: AnswerActor;
  },
  db: Db,
): Promise<svc.ConversationTurnOutcome> {
  const ctrl = registerConversationAbort(params.tenant_id, params.conversation_id);
  try {
    return await svc.respondElicitation(
      {
        ...params,
        answer_actor: testAnswerActor(params.actor_id, params.answer_actor),
        turn_abort_ctrl: ctrl,
      },
      db,
    );
  } finally {
    unregisterConversationAbort(params.tenant_id, params.conversation_id, ctrl);
  }
}

/** persist the appended message, run the turn. */
export async function appendMessageWithTurn(
  params: svc.AppendMessageParams &
    Pick<
      svc.RunConversationTurnParams,
      "onEvent" | "runtime_context" | "surface" | "next_suggestion_suppress" | "principal"
    > & { answer_actor?: AnswerActor },
  db: Db,
): Promise<svc.ConversationTurnOutcome> {
  const {
    onEvent,
    runtime_context,
    surface,
    next_suggestion_suppress,
    answer_actor,
    principal,
    ...appendParams
  } = params;
  const appended = await svc.appendUserMessage(appendParams, db);
  const ctrl = registerConversationAbort(appendParams.tenant_id, appendParams.conversation_id);
  try {
    return await svc.runConversationTurn(
      {
        tenant_id: appendParams.tenant_id,
        conversation_id: appendParams.conversation_id,
        actor_id: appendParams.actor_id ?? null,
        user_message: appended.message,
        answer_actor: testAnswerActor(appendParams.actor_id, answer_actor),
        user_memory: appended.user_memory,
        turn_abort_ctrl: ctrl,
        ...(appendParams.permission_mode ? { permission_mode: appendParams.permission_mode } : {}),
        ...(onEvent ? { onEvent } : {}),
        ...(runtime_context ? { runtime_context } : {}),
        ...(surface ? { surface } : {}),
        ...(next_suggestion_suppress !== undefined ? { next_suggestion_suppress } : {}),
        ...(principal !== undefined ? { principal } : {}),
      },
      db,
    );
  } finally {
    unregisterConversationAbort(appendParams.tenant_id, appendParams.conversation_id, ctrl);
  }
}

// Ensure the v3.5 config loader is bootstrapped so getConfig() calls
// inside the conversation pipeline don't 500 with "called before
// loadConfig()". Idempotent — running tests load config once per
// process and subsequent calls no-op.
async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    // not yet loaded — fall through.
  }
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-conv-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/conv-test", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

export interface ConversationTestCtx {
  testDb: TestDb;
  tenant_id: string;
  user_id: string;
  connector_id: string;
  cleanup: () => Promise<void>;
}

export async function createConversationTestCtx(label: string): Promise<ConversationTestCtx> {
  process.env.LLM_PROVIDER = "mock";
  await ensureConfigLoaded();
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
