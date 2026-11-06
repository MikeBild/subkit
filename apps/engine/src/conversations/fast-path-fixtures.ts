import { afterAll, beforeAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { tenants } from "../db/schema/identity.ts";
import { conversations, workflows, workflowVersions } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { resetMockProvider } from "../llm/mock-provider.ts";
import { TEST_HUMAN_ANSWER } from "../test-helpers/answer-actor.ts";
import { createMockServer, jsonResponse, type MockServer } from "../test-helpers/mock-http.ts";
import type { FastPathParams } from "./fast-path.ts";

export let tdb: TestDb;
export let tenantId: string;
export let conversationId: string;
export let remote: MockServer;

export function makePrincipal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: "00000000-0000-4000-8000-0000000000fb",
    tenant_id: tenantId,
    roles: ["admin"],
    ...overrides,
  };
}

export async function makeConversation(): Promise<string> {
  const [conv] = await tdb.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active" })
    .returning();
  if (!conv) throw new Error("conversation seed failed");
  return conv.id;
}

export function makeParams(msg: string, overrides: Partial<FastPathParams> = {}): FastPathParams {
  return {
    db: tdb.db,
    tenant_id: tenantId,
    conversation_id: conversationId,
    actor_id: null,
    principal: makePrincipal(),
    user_message: msg,
    answer_actor: TEST_HUMAN_ANSWER,
    ...overrides,
  };
}

export async function seedMinimalWorkflow(
  slug: string,
  category = "other",
): Promise<{ id: string }> {
  const [wf] = await tdb.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug,
      name: slug,
      category,
      lifecycle: "active",
      is_tool: true,
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");

  const [v] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: wf.id,
      version: 1,
      dag: {
        name: slug,
        slug,
        steps: [{ id: "s1", kind: "request", method: "GET", url: remote.baseUrl }],
      },
    })
    .returning();
  if (!v) throw new Error("seed workflow version failed");

  await tdb.db.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));

  return { id: wf.id };
}

export function useFastPathSetup(): void {
  beforeAll(async () => {
    tdb = await createTestDb("conversations-fast-path");
    remote = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true }));

    const [t] = await tdb.db
      .insert(tenants)
      .values({ slug: "t-fp", display_name: "Fast Path Tenant" })
      .returning();
    if (!t) throw new Error("tenant seed failed");
    tenantId = t.id;
  });

  afterAll(async () => {
    await remote.close();
    await tdb.cleanup();
  });

  beforeEach(async () => {
    resetMockProvider();
    conversationId = await makeConversation();
    await tdb.db.delete(workflowVersions);
    await tdb.db.delete(workflows);
  });
}
