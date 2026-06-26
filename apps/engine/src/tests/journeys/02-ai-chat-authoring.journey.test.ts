// User story: As an operator, I want to author a workflow through an AI
// conversation and commit it via a human-in-the-loop approval, so that
// I don't have to hand-edit JSON.
// Acceptance criteria:
//   - AC1: A signed Slack `app_mention` ingress verifies against the
//          Slack HMAC scheme and is accepted; a bad signature is denied.
//   - AC2: Starting a conversation with "list users from the api" drives
//          the canned mock-LLM plan through an approval.
//   - AC3: Approving the pending approval commits the draft and creates
//          a real workflow row.
// Spec refs: docs/input-surfaces.md, docs/authoring.md,
//            docs/authoring.md, docs/execution.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { ChatAdapterRegistry } from "../../chat/registry.ts";
import { SlackAdapter } from "../../chat/slack/adapter.ts";
import { connectors, conversations, workflows } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { buildDefaultRegistry, createApp } from "../../http/server.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { JOURNEY_HOOK_TIMEOUT } from "./setup.ts";

const SIGNING_SECRET = "slack-signing-secret-ABC";

function signSlack(ts: string, body: string): string {
  const mac = createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${body}`).digest("hex");
  return `v0=${mac}`;
}

interface LocalCtx {
  testDb: TestDb;
  baseUrl: string;
  tenantId: string;
  apiKey: string;
  connectorId: string;
  cleanup: () => Promise<void>;
}

let ctx: LocalCtx;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();

  const testDb = await createTestDb("j-chat-ai");
  const { apiKeys, systemAccounts, tenants, users } = await import("../../db/schema/index.ts");
  const { createHash, randomBytes } = await import("node:crypto");

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-chat", display_name: "Chat Tenant" })
    .returning();
  if (!tenant) throw new Error("seed tenant");
  const [user] = await testDb.db
    .insert(users)
    .values({ tenant_id: tenant.id, email: "admin@chat.test", role: "admin" })
    .returning();
  if (!user) throw new Error("seed user");
  const [sys] = await testDb.db
    .insert(systemAccounts)
    .values({ tenant_id: tenant.id, name: "bot", description: "bot" })
    .returning();
  if (!sys) throw new Error("seed system_account");

  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
  const plain = `wf_live_${rand}`;
  const [key] = await testDb.db
    .insert(apiKeys)
    .values({
      tenant_id: tenant.id,
      user_id: user.id,
      prefix: plain.slice(0, 12),
      token_sha256: createHash("sha256").update(plain).digest("hex"),
      scopes: ["*"],
    })
    .returning();
  if (!key) throw new Error("seed api_key");

  // Seed a connector so the canned list-users plan has something to
  // ground in. The mock provider's plan wires its step to this id.
  const [connector] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenant.id,
      slug: "api-chat",
      display_name: "API Chat",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://jsonplaceholder.typicode.com",
      config: {},
    })
    .returning();
  if (!connector) throw new Error("seed connector");

  // Register a Slack adapter as the fallback verifier. The chat route
  // resolves `findVerifier('slack')` so fallback adapters are enough
  // for HMAC verification. No outbound Slack calls are made by the
  // route itself — the adapter only verifies + normalizes.
  const chatRegistry = new ChatAdapterRegistry();
  const slackAdapter = new SlackAdapter({
    signingSecret: SIGNING_SECRET,
    botToken: "xoxb-test-unused",
    slackApiUrl: "http://127.0.0.1:1/",
  });
  chatRegistry.registerFallback("slack", slackAdapter);

  const registry = buildDefaultRegistry(testDb.db);
  // The chat HTTP route's default enqueue resolves pg-boss via `getBoss()`,
  // which throws when no boss is started — this journey only validates
  // the route's HMAC verify + URL-verification path (no agentic turn),
  // so we pass a no-op enqueue stub. The escape hatch exists exactly
  // for tests of the route surface that don't run the worker.
  const app = createApp({
    db: testDb.db,
    registry,
    chatRegistry,
    chatEnqueue: async () => {},
  });
  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  const addr = (server as unknown as { address: () => { port: number } | null }).address();
  if (!addr) throw new Error("no addr");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  ctx = {
    testDb,
    baseUrl,
    tenantId: tenant.id,
    apiKey: plain,
    connectorId: connector.id,
    cleanup: async () => {
      const s = server as unknown as {
        close: (cb: () => void) => void;
        closeAllConnections?: () => void;
      };
      // Force any idle keep-alive sockets to drop so close() resolves.
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
      await testDb.cleanup();
    },
  };
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey: AI chat authoring", () => {
  test("AC1: Slack app_mention with a good HMAC verifies, bad HMAC is denied", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "app_mention",
        channel: "C999",
        user: "U_ALICE",
        text: "<@UBOT> list users",
        ts: "1700000000.000100",
      },
    });
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const ts = String(Math.floor(Date.now() / 1000));
    const goodSig = signSlack(ts, body);
    const ok = await fetch(`${ctx.baseUrl}/v1/chat/slack/events`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": goodSig,
      },
    });
    expect(ok.status).toBe(200);

    const bad = await fetch(`${ctx.baseUrl}/v1/chat/slack/events`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": "v0=deadbeef",
      },
    });
    expect(bad.status).toBe(401);
  });

  test("AC2+AC3: conversation run drives approval, approve commits a workflow", async () => {
    // Start a conversation via the public REST surface with the
    // canned "list users" message so the mock plan kicks in.
    const createRes = await fetch(`${ctx.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        connector_id: ctx.connectorId,
        initial_message: "please list users from the api",
      }),
    });
    expect(createRes.status).toBe(201);
    const outcome = (await createRes.json()) as {
      conversation: { id: string; status: string };
      pending_elicitation_id?: string;
      status: string;
    };
    expect(outcome.status).toBe("awaiting_input");
    expect(outcome.pending_elicitation_id).toBeDefined();
    const elicitationId = outcome.pending_elicitation_id!;
    const convId = outcome.conversation.id;

    // Answer the pending askUser.confirm elicitation with
    // `{confirmed: true}` — the engine resumes the loop and commits.
    const approveRes = await fetch(
      `${ctx.baseUrl}/v1/conversations/${convId}/elicitations/${elicitationId}/respond`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ctx.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ output: { confirmed: true } }),
      },
    );
    expect(approveRes.status).toBe(200);
    const approveOutcome = (await approveRes.json()) as {
      status: string;
      committed_workflow_id?: string;
    };
    expect(approveOutcome.status).toBe("committed");
    const committedWorkflowId = approveOutcome.committed_workflow_id;
    expect(committedWorkflowId).toBeTruthy();

    // A new workflow row exists.
    const wfRows = await ctx.testDb.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, committedWorkflowId!));
    expect(wfRows.length).toBe(1);
    expect(wfRows[0]?.lifecycle).toBe("active");

    // Conversation state reflects committed.
    const convRows = await ctx.testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, convId));
    expect(convRows[0]?.status).toBe("committed");
  });
});
