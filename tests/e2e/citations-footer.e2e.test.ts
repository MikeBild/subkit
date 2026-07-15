// Citations footer — a grounded answer renders "Sources: <source name>"
// under the assistant text; an ungrounded answer renders no footer at all.
//
// Reliable seam: rather than drive a real conversational turn through a
// PTY and hope the mock model calls search_knowledge on its own, this
// seeds a knowledge chunk directly (same shape as
// apps/engine/src/embeddings/tests/backfill-scoping.test.ts) and pins the
// mock provider's converse plan (getMockProvider().setConversePlan) to call
// search_knowledge with a query that matches it. The engine still runs the
// real FTS lookup, the real citation harvester
// (apps/engine/src/conversations/citations.ts), and the real terminal
// `citations` TurnEvent (apps/engine/src/conversations/loop.ts); only the
// model's tool choice is canned. Driven through `sk -p ... --output text`
// (apps/sk/src/headless.ts) — the same non-interactive seam
// workflow-save-follow-up.e2e.test.ts uses — so the assertion covers the
// real user-visible text-mode render (headless.ts + citations-footer.ts),
// not the engine's internal event shape.
//
// LLM: mock — resetMockProvider() runs in boot(); the search_knowledge tool
// call is canned per-conversation, the answer text is the mock's canned ack.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createEmptyDraftDocument } from "../../apps/engine/src/conversations/authoring-state.ts";
import { conversations } from "../../apps/engine/src/db/schema/index.ts";
import {
  knowledgeChunks,
  knowledgeSources,
} from "../../apps/engine/src/db/schema/knowledge_sources.ts";
import { getMockProvider } from "../../apps/engine/src/llm/mock-provider.ts";
import { boot, cli, type E2EEnv, expectSuccess, shutdown } from "./setup.ts";

let env: E2EEnv;
let seq = 0;

beforeAll(async () => {
  env = await boot("citations-footer", { llm: "mock" });
}, 90_000);

afterAll(async () => {
  await shutdown(env);
}, 30_000);

/** Fresh, collision-free label per seeded fixture in this suite. */
function label(): string {
  seq += 1;
  return `citefoot-${seq.toString().padStart(4, "0")}`;
}

/** Seed an active global knowledge source with one FTS-searchable chunk.
 *  Direct DB insert (no ingestion pipeline, no polling) — deterministic. */
async function seedKnowledgeChunk(opts: {
  sourceName: string;
  token: string;
}): Promise<{ sourceId: string }> {
  const l = label();
  const [source] = await env.db
    .insert(knowledgeSources)
    .values({
      tenant_id: env.tenantId,
      name: opts.sourceName,
      slug: `source-${l}`,
      source_type: "inline",
      source_uri: `${l}.md`,
      version: "v1",
      status: "active",
      scope: "global",
    })
    .returning();
  if (!source) throw new Error("seed knowledge source failed");
  await env.db.insert(knowledgeChunks).values({
    tenant_id: env.tenantId,
    knowledge_source_id: source.id,
    ordinal: 0,
    title: opts.sourceName,
    content: `The magic deployment marker is ${opts.token}. It identifies this source.`,
    byte_size: 80,
    fingerprint: `fp-${l}`,
  });
  return { sourceId: source.id };
}

/** Seed a plain, ready-to-chat conversation (no active workflow/connector
 *  draft) owned by the admin persona. Mirrors the seeding shape in
 *  workflow-save-follow-up.e2e.test.ts, minus the workflow-draft fields
 *  this suite does not need. */
async function seedConversation(): Promise<string> {
  const draft = {
    ...createEmptyDraftDocument(),
    session: { permission_mode: "auto" as const },
  };
  const [conversation] = await env.db
    .insert(conversations)
    .values({
      tenant_id: env.tenantId,
      status: "active",
      owner_id: env.personas.admin.userId,
      draft: draft as unknown as Record<string, unknown>,
    })
    .returning();
  if (!conversation) throw new Error("conversation insert failed");
  return conversation.id;
}

describe("citations footer over `sk -p --output text`", () => {
  test("a search_knowledge-grounded answer renders a Sources: footer naming the source", async () => {
    const token = `zphcite${label().replace(/[^a-z0-9]/g, "")}`;
    const sourceName = `Deploy Runbook ${label()}`;
    await seedKnowledgeChunk({ sourceName, token });
    const conversationId = await seedConversation();

    getMockProvider().setConversePlan(conversationId, [
      { tool: "search_knowledge", args: { query: token } },
    ]);

    const result = await cli(
      ["--r", conversationId, "--p", `What do you know about ${token}?`, "--output", "text"],
      { env, persona: "admin", timeout: 60_000 },
    );
    expectSuccess(result, "sk --p (grounded question)");
    expect(result.stdout).toContain("Sources:");
    expect(result.stdout).toContain(sourceName);
  }, 60_000);

  test("an ungrounded answer (no search_knowledge call) renders no Sources: footer", async () => {
    const conversationId = await seedConversation();

    // No converse plan installed for this conversation id — the mock
    // model immediately acknowledges with plain text, no tool call.
    const result = await cli(
      ["--r", conversationId, "--p", "just say hi, no lookups needed", "--output", "text"],
      { env, persona: "admin", timeout: 60_000 },
    );
    expectSuccess(result, "sk --p (ungrounded question)");
    expect(result.stdout).not.toContain("Sources:");
  }, 60_000);
});
