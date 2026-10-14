import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import {
  apiKeys,
  auditLog,
  connectors,
  conversationMessages,
  conversations,
  conversationToolCalls,
  systemAccounts,
} from "../../db/schema/index.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/knowledge_sources.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";

let http: HttpTestServer;
let connectorId: string;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  http = await createHttpTestServer("conv-append-stream");
  const [row] = await http.db
    .insert(connectors)
    .values({
      tenant_id: http.tenantId,
      slug: "api-append-stream",
      display_name: "API append stream",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://jsonplaceholder.typicode.com",
      config: {},
    })
    .returning();
  if (!row) throw new Error("seed connector failed");
  connectorId = row.id;
});

afterAll(async () => {
  await http.cleanup();
});

interface SseEvent {
  event: string;
  data: string;
}

async function readSse(response: Response): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  if (!response.body) return out;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of chunk.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        const val = line.slice(colon + 1).replace(/^\s/, "");
        if (key === "event") event = val;
        else if (key === "data") dataLines.push(val);
      }
      if (dataLines.length > 0) out.push({ event, data: dataLines.join("\n") });
      sep = buffer.indexOf("\n\n");
    }
  }
  return out;
}

describe("http/conversations POST SSE", () => {
  test("conversation_started arrives before the rest of the turn (live, not buffered)", async () => {
    const res = await fetch(`${http.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${http.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        connector_id: connectorId,
        initial_message: "list users from the api",
      }),
    });
    expect(res.status).toBe(200);

    if (!res.body) throw new Error("no body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstEvent: string | null = null;
    let chunkCount = 0;
    let frameCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount += 1;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (firstEvent === null) {
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event:")) {
              firstEvent = line.slice("event:".length).trim();
              break;
            }
          }
        }
        frameCount += 1;
        sep = buffer.indexOf("\n\n");
      }
    }
    expect(firstEvent).toBe("conversation_started");
    expect(frameCount).toBeGreaterThan(2);
    expect(chunkCount).toBeGreaterThanOrEqual(2);
  });

  test("POST /v1/conversations returns SSE with conversation_started + outcome frames when Accept: text/event-stream", async () => {
    const res = await fetch(`${http.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${http.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        connector_id: connectorId,
        initial_message: "list users from the api",
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/event-stream/);

    const frames = await readSse(res);
    const eventTypes = frames.map((f) => f.event);

    expect(eventTypes[0]).toBe("conversation_started");
    expect(eventTypes[eventTypes.length - 1]).toBe("outcome");

    expect(eventTypes).toContain("message");
    expect(eventTypes).toContain("tool_call_start");
    expect(eventTypes).toContain("tool_call_end");
    expect(eventTypes).toContain("completed");

    const startFrame = frames.find((f) => f.event === "conversation_started");
    expect(startFrame).toBeDefined();
    if (startFrame) {
      const parsed = JSON.parse(startFrame.data) as {
        conversation: { id: string; tenant_id: string };
      };
      expect(parsed.conversation.id).toBeDefined();
      expect(parsed.conversation.tenant_id).toBe(http.tenantId);
    }

    const outcomeFrame = frames.find((f) => f.event === "outcome");
    expect(outcomeFrame).toBeDefined();
    if (outcomeFrame) {
      const parsed = JSON.parse(outcomeFrame.data) as { status: string };
      expect(["awaiting_input", "active", "committed"]).toContain(parsed.status);
    }
  });

  test("POST /v1/conversations without Accept: text/event-stream returns JSON (backward compat)", async () => {
    const res = await fetch(`${http.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${http.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        connector_id: connectorId,
        initial_message: "list users from the api",
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/);
    const body = (await res.json()) as { conversation: { id: string }; events: unknown[] };
    expect(body.conversation.id).toBeDefined();
    expect(Array.isArray(body.events)).toBe(true);
  });

  test("POST /v1/conversations/:id/messages with Accept: text/event-stream streams the turn live", async () => {
    const seed = await fetch(`${http.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${http.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ connector_id: connectorId }),
    });
    const seedBody = (await seed.json()) as { conversation: { id: string } };
    const conversationId = seedBody.conversation.id;

    const res = await fetch(`${http.baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${http.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ message: "list users from the api" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/event-stream/);

    const frames = await readSse(res);
    const eventTypes = frames.map((f) => f.event);

    expect(eventTypes).not.toContain("conversation_started");
    expect(eventTypes[eventTypes.length - 1]).toBe("outcome");
    expect(eventTypes).toContain("completed");
  });
});

describe("http/conversations citations replay", () => {
  async function seedKnowledgeChunk(
    http: HttpTestServer,
    opts: { sourceName: string; token: string },
  ): Promise<void> {
    const [source] = await http.db
      .insert(knowledgeSources)
      .values({
        tenant_id: http.tenantId,
        name: opts.sourceName,
        slug: "citations-replay-source",
        source_type: "inline",
        source_uri: "citations-replay.md",
        version: "v1",
        status: "active",
        scope: "global",
      })
      .returning();
    if (!source) throw new Error("seed knowledge source failed");
    await http.db.insert(knowledgeChunks).values({
      tenant_id: http.tenantId,
      knowledge_source_id: source.id,
      ordinal: 0,
      title: opts.sourceName,
      content: `The magic deployment marker is ${opts.token}. It identifies this source.`,
      byte_size: 80,
      fingerprint: "fp-citations-replay",
    });
  }

  async function seedConversation(http: HttpTestServer, owner_id = http.userId): Promise<string> {
    const draft = {
      ...createEmptyDraftDocument(),
      session: { permission_mode: "auto" as const },
    };
    const [conversation] = await http.db
      .insert(conversations)
      .values({
        tenant_id: http.tenantId,
        status: "active",
        owner_id,
        draft: draft as unknown as Record<string, unknown>,
      })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");
    return conversation.id;
  }

  test("a buffered (JSON) append that grounds via search_knowledge replays a citations frame naming the source", async () => {
    const token = "zphreplaymarker9001";
    const sourceName = "Citations Replay Runbook";
    await seedKnowledgeChunk(http, { sourceName, token });
    await http.db
      .update(systemAccounts)
      .set({ role_id: await builtinRoleId(http.db, "admin") })
      .where(eq(systemAccounts.id, http.systemAccountId));
    const citationApiKey = "wf_live_citation_system_account_test_key";
    await http.db.insert(apiKeys).values({
      tenant_id: http.tenantId,
      system_account_id: http.systemAccountId,
      prefix: citationApiKey.slice(0, 12),
      token_sha256: createHash("sha256").update(citationApiKey).digest("hex"),
      scopes: ["*"],
    });
    const conversationId = await seedConversation(http, http.systemAccountId);

    getMockProvider().setConversePlan(conversationId, [
      { tool: "search_knowledge", args: { query: token } },
    ]);

    const appendRes = await fetch(`${http.baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${citationApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: `What do you know about ${token}?` }),
    });
    expect(appendRes.status).toBe(200);
    expect(appendRes.headers.get("content-type") ?? "").toMatch(/application\/json/);

    const streamRes = await fetch(`${http.baseUrl}/v1/conversations/${conversationId}/stream`, {
      headers: { authorization: `Bearer ${citationApiKey}`, accept: "text/event-stream" },
    });
    expect(streamRes.status).toBe(200);
    const frames = await readSse(streamRes);
    const citationsFrame = frames.find((f) => f.event === "citations");
    expect(citationsFrame).toBeDefined();
    const parsed = JSON.parse(citationsFrame!.data) as {
      citations: Array<{ source_type: string; id: string; source_name?: string }>;
      parent_message_id?: string;
    };
    expect(parsed.citations.length).toBeGreaterThan(0);
    expect(parsed.citations[0]?.source_type).toBe("knowledge_chunk");
    expect(parsed.citations[0]?.source_name).toBe(sourceName);

    const [citationAudit] = await http.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, http.tenantId),
          eq(auditLog.action, AuditAction.CONVERSATION_ANSWER_CITED),
          eq(auditLog.resource_id, conversationId),
        ),
      )
      .limit(1);
    expect(citationAudit).toEqual({ actor_type: "system_account", actor_id: http.systemAccountId });

    const assistantMessageIds = frames
      .filter(
        (f) =>
          f.event === "message" && (JSON.parse(f.data) as { role: string }).role === "assistant",
      )
      .map((f) => (JSON.parse(f.data) as { id: string }).id);
    expect(assistantMessageIds.length).toBeGreaterThan(0);
    expect(parsed.parent_message_id).toBe(assistantMessageIds[assistantMessageIds.length - 1]);
  });

  test("a buffered append with no grounding tool call replays no citations frame", async () => {
    const conversationId = await seedConversation(http);

    const appendRes = await fetch(`${http.baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${http.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "just say hi, no lookups needed" }),
    });
    expect(appendRes.status).toBe(200);

    const streamRes = await fetch(`${http.baseUrl}/v1/conversations/${conversationId}/stream`, {
      headers: { authorization: `Bearer ${http.apiKey}`, accept: "text/event-stream" },
    });
    expect(streamRes.status).toBe(200);
    const frames = await readSse(streamRes);
    expect(frames.find((f) => f.event === "citations")).toBeUndefined();
  });

  test("a tool-only turn (grounded but no assistant prose) replays NO citations frame", async () => {
    const conversationId = await seedConversation(http);
    await http.db.insert(conversationMessages).values({
      tenant_id: http.tenantId,
      conversation_id: conversationId,
      role: "user",
      content: { text: "look it up" },
    });
    const [assistant] = await http.db
      .insert(conversationMessages)
      .values({
        tenant_id: http.tenantId,
        conversation_id: conversationId,
        role: "assistant",
        content: { parts: [] },
      })
      .returning();
    if (!assistant) throw new Error("assistant message insert failed");
    await http.db.insert(conversationToolCalls).values({
      tenant_id: http.tenantId,
      conversation_id: conversationId,
      parent_message_id: assistant.id,
      tool: "search_knowledge",
      input: { query: "anything" },
      output: { hits: [{ id: "chunk-x", source_name: "Some Source" }] },
    });

    const streamRes = await fetch(`${http.baseUrl}/v1/conversations/${conversationId}/stream`, {
      headers: { authorization: `Bearer ${http.apiKey}`, accept: "text/event-stream" },
    });
    expect(streamRes.status).toBe(200);
    const frames = await readSse(streamRes);
    expect(frames.find((f) => f.event === "citations")).toBeUndefined();
  });
});
