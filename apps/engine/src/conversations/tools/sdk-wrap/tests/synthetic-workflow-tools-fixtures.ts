import { afterAll, beforeAll, beforeEach } from "bun:test";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../../auth/types.ts";
import { tenants } from "../../../../db/schema/identity.ts";
import { conversations, workflows, workflowVersions } from "../../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../../db/tests/setup.ts";
import { resetMockProvider } from "../../../../llm/mock-provider.ts";
import type { ToolContext } from "../../index.ts";
import type { TurnSignals } from "../state.ts";

export let tdb: TestDb;
export let tenantId: string;
export let conversationId: string;
export let server: ReturnType<typeof createServer>;
export let requestUrl: string;
export let requests = 0;
export let receivedBody = "";

export function makePrincipal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: "00000000-0000-4000-8000-0000000000fc",
    tenant_id: tenantId,
    roles: ["admin"],
    ...overrides,
  };
}

export function makeTurnSignals(): TurnSignals {
  return {
    step: 0,
    toolChain: Promise.resolve(),
    toolInvocationCount: new Map(),
    toolLastErrorHash: new Map(),
    toolArgsRepeat: new Map(),
    toolValidationFingerprint: new Map(),
    toolErrorCodeRepeat: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
    lastExecutionSuccess: null,
    pendingChildToolCallIds: [],
    pendingChildElicitationIds: [],
  };
}

export function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const logs: Array<{ level: string; message: string }> = [];
  return {
    db: tdb.db,
    tenant_id: tenantId,
    conversation_id: conversationId,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as ToolContext["engineClient"],
    getDraft: () => ({ workflow: { name: "draft", steps: [] } as never }),
    setDraft: async () => {},
    onLog: (level, message) => logs.push({ level, message }),
    ...overrides,
  } as ToolContext;
}

export async function seedTool(slug: string): Promise<{ id: string }> {
  const [wf] = await tdb.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug,
      name: slug,
      lifecycle: "active",
      is_tool: true,
    })
    .returning();
  if (!wf) throw new Error("workflow seed failed");

  const [v] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: wf.id,
      version: 1,
      dag: { name: slug, slug, steps: [{ id: "s1", kind: "request", url: requestUrl }] },
    })
    .returning();
  if (!v) throw new Error("version seed failed");

  await tdb.db.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));
  return { id: wf.id };
}

export function useSyntheticWorkflowToolsSetup(): void {
  beforeAll(async () => {
    tdb = await createTestDb("synthetic-workflow-tools");

    const [t] = await tdb.db
      .insert(tenants)
      .values({ slug: "t-swt", display_name: "Synthetic Tools Tenant" })
      .returning();
    if (!t) throw new Error("tenant seed failed");
    tenantId = t.id;
    server = createServer((request, response) => {
      request.on("data", (chunk) => {
        receivedBody += chunk.toString();
      });
      requests += 1;
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture address missing");
    requestUrl = `http://127.0.0.1:${address.port}/read`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await tdb.cleanup();
  });

  beforeEach(async () => {
    resetMockProvider();
    requests = 0;
    receivedBody = "";
    const [conv] = await tdb.db
      .insert(conversations)
      .values({ tenant_id: tenantId, status: "active" })
      .returning();
    if (!conv) throw new Error("conversation seed failed");
    conversationId = conv.id;

    await tdb.db.delete(workflowVersions);
    await tdb.db.delete(workflows);
  });
}
