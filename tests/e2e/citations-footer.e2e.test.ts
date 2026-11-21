import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createEmptyDraftDocument } from "../../apps/engine/src/conversations/authoring-state/index.ts";
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

function label(): string {
  seq += 1;
  return `citefoot-${seq.toString().padStart(4, "0")}`;
}

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

async function seedConversation(): Promise<string> {
  const draft = {
    ...createEmptyDraftDocument(),
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

    const result = await cli(
      ["--r", conversationId, "--p", "just say hi, no lookups needed", "--output", "text"],
      { env, persona: "admin", timeout: 60_000 },
    );
    expectSuccess(result, "sk --p (ungrounded question)");
    expect(result.stdout).not.toContain("Sources:");
  }, 60_000);
});
