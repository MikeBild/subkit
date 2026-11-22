import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedPrincipal } from "../../auth/types.ts";
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
import { writeSetupPreferences } from "../../identity/setup-preferences.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { registerConversationAbort, unregisterConversationAbort } from "../abort.ts";
import { type AnswerActor, MODEL_RELAYED_ANSWER } from "../answer-actor.ts";
import * as svc from "../service/index.ts";

type AskBeforeWritingOption = { ask_before_writing?: boolean };

async function personWhoAsksBeforeWriting(
  db: Db,
  tenant_id: string,
  actor_id: string | null | undefined,
): Promise<ResolvedPrincipal> {
  if (!actor_id) throw new Error("ask_before_writing needs a person as actor");
  await writeSetupPreferences(db, { tenant_id, user_id: actor_id }, { ask_before_writing: true });
  return { provider: "test", kind: "user", id: actor_id, tenant_id, roles: ["admin"] };
}

function testAnswerActor(actor_id: string | null | undefined, override?: AnswerActor): AnswerActor {
  if (override) return override;
  return actor_id ? { kind: "human", user_id: actor_id, via: "chat" } : MODEL_RELAYED_ANSWER;
}

export async function createConversationWithTurn(
  params: svc.CreateConversationParams &
    Pick<svc.RunConversationTurnParams, "onEvent" | "runtime_context" | "principal"> & {
      answer_actor?: AnswerActor;
    } & AskBeforeWritingOption,
  db: Db,
): Promise<svc.ConversationTurnOutcome> {
  const { onEvent, runtime_context, answer_actor, ask_before_writing, ...rest } = params;
  const { principal: givenPrincipal, ...createParams } = rest;
  const principal = ask_before_writing
    ? await personWhoAsksBeforeWriting(db, createParams.tenant_id, createParams.actor_id)
    : givenPrincipal;
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

export async function respondElicitationForTest(
  params: Omit<svc.RespondElicitationParams, "turn_abort_ctrl" | "answer_actor"> & {
    answer_actor?: AnswerActor;
  } & AskBeforeWritingOption,
  db: Db,
): Promise<svc.ConversationTurnOutcome> {
  const { ask_before_writing, ...rest } = params;
  const principal = ask_before_writing
    ? await personWhoAsksBeforeWriting(db, rest.tenant_id, rest.actor_id)
    : rest.principal;
  const ctrl = registerConversationAbort(params.tenant_id, params.conversation_id);
  try {
    return await svc.respondElicitation(
      {
        ...rest,
        ...(principal !== undefined ? { principal } : {}),
        answer_actor: testAnswerActor(params.actor_id, params.answer_actor),
        turn_abort_ctrl: ctrl,
      },
      db,
    );
  } finally {
    unregisterConversationAbort(params.tenant_id, params.conversation_id, ctrl);
  }
}

export async function appendMessageWithTurn(
  params: svc.AppendMessageParams &
    Pick<
      svc.RunConversationTurnParams,
      | "onEvent"
      | "runtime_context"
      | "surface"
      | "next_suggestion_suppress"
      | "principal"
      | "elicitationBridge"
    > & { answer_actor?: AnswerActor } & AskBeforeWritingOption,
  db: Db,
): Promise<svc.ConversationTurnOutcome> {
  const {
    onEvent,
    runtime_context,
    surface,
    next_suggestion_suppress,
    answer_actor,
    principal: givenPrincipal,
    elicitationBridge,
    ask_before_writing,
    ...appendParams
  } = params;
  const principal = ask_before_writing
    ? await personWhoAsksBeforeWriting(db, appendParams.tenant_id, appendParams.actor_id)
    : givenPrincipal;
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
        ...(onEvent ? { onEvent } : {}),
        ...(runtime_context ? { runtime_context } : {}),
        ...(surface ? { surface } : {}),
        ...(next_suggestion_suppress !== undefined ? { next_suggestion_suppress } : {}),
        ...(principal !== undefined ? { principal } : {}),
        ...(elicitationBridge ? { elicitationBridge } : {}),
      },
      db,
    );
  } finally {
    unregisterConversationAbort(appendParams.tenant_id, appendParams.conversation_id, ctrl);
  }
}

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "subkit-cfg-conv-test-"));
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
  testEnv.LLM_PROVIDER = "mock";
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
      role_id: await builtinRoleId(testDb.db, "admin"),
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
