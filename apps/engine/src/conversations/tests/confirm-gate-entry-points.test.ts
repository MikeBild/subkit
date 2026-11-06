import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { closeDb, type Db } from "../../db/client.ts";
import { auditLog, conversations, tenants, toolApprovals, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { buildMcpStubCtx } from "../../mcp/adapter.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { hashToolArgs } from "../../tools/approval.ts";
import { dispatchTool } from "../../tools/dispatcher.ts";
import { getUnifiedRegistry } from "../../tools/index.ts";
import { CHAT_READONLY_TOOLS } from "../tools/authoring-palette.ts";
import { getTool, type ToolContext } from "../tools/index.ts";
import { wrapOne } from "../tools/sdk-wrap/invoke.ts";
import { wrapTools } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";
import { freshSignals } from "./turn-signals.ts";

const TOOL = "create_knowledge_source";
const ARGS = { mode: "inline", name: "Entry point source", content: "# Entry point" };
const LOOP_SURFACES: ReadonlyArray<NonNullable<ToolContext["surface"]>> = [
  "web",

  "sk_interactive",
  "sk_headless",
];

let tdb: TestDb;
let db: Db;
let tenantId: string;
let otherTenantId: string;
let principal: ResolvedPrincipal;
const originalDatabaseUrl = process.env.DATABASE_URL;

function toolCtx(
  conversation_id: string,
  surface: NonNullable<ToolContext["surface"]>,
): ToolContext {
  return {
    db,
    tenant_id: tenantId,
    conversation_id,
    actor_id: principal.id,
    principal,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: tenantId,
      actor_id: principal.id,
      actor_type: "user",
      db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
    surface,
  };
}

async function newConversation(): Promise<string> {
  const [row] = await tdb.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("conversation seed failed");
  return row.id;
}

async function approvalIds(tenant: string): Promise<Set<string>> {
  const rows = await tdb.db
    .select({ id: toolApprovals.id })
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, tenant), eq(toolApprovals.tool, TOOL)));
  return new Set(rows.map((r) => r.id));
}

async function newApproval(before: Set<string>) {
  const rows = await tdb.db
    .select()
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, tenantId), eq(toolApprovals.tool, TOOL)));
  const fresh = rows.filter((r) => !before.has(r.id));
  expect(fresh).toHaveLength(1);
  return fresh[0]!;
}

async function transitionsFor(approvalId: string, conversationId: string | null) {
  const rows = await tdb.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenantId),
        inArray(auditLog.resource_id, conversationId ? [approvalId, conversationId] : [approvalId]),
        inArray(auditLog.action, [
          AuditAction.APPROVAL_REQUESTED,
          AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED,
        ]),
      ),
    );
  return rows.map((r) => r.action).sort();
}

beforeAll(async () => {
  tdb = await createTestDb("confirm-gate-entry-points");
  db = tdb.db as unknown as Db;
  await closeDb();
  process.env.DATABASE_URL = tdb.url;
  resetMockProvider();
  const [tenant] = await tdb.db
    .insert(tenants)
    .values({ slug: "t-gate-entry-points", display_name: "Gate Entry Points" })
    .returning();
  const [other] = await tdb.db
    .insert(tenants)
    .values({ slug: "t-gate-entry-points-other", display_name: "Gate Entry Points Other" })
    .returning();
  if (!tenant || !other) throw new Error("tenant seed failed");
  tenantId = tenant.id;
  otherTenantId = other.id;
  const [person] = await tdb.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "approver@gate-entry-points.test.local",
      role_id: await builtinRoleId(tdb.db, "admin"),
    })
    .returning();
  if (!person) throw new Error("user seed failed");
  principal = {
    provider: "test",
    kind: "user",
    id: person.id,
    tenant_id: tenantId,
    roles: ["admin"],
  };
}, 30_000);

afterAll(async () => {
  await closeDb();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await tdb.cleanup();
}, 30_000);

describe("one gated call through every entry point", () => {
  const expectedHash = hashToolArgs(ARGS);
  const conversationTransitions = [
    AuditAction.APPROVAL_REQUESTED,
    AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED,
  ].sort();

  for (const surface of LOOP_SURFACES) {
    test(`conversation loop on ${surface}: same args_hash, same audit transitions`, async () => {
      const inner = getTool(TOOL);
      if (!inner) throw new Error(`${TOOL} is not registered`);
      const conversationId = await newConversation();
      const before = await approvalIds(tenantId);
      const wrapped = wrapOne(
        inner,
        toolCtx(conversationId, surface),
        freshSignals(),
        [] as TurnEvent[],
        db,
        {},
        null,
      );
      const result = await wrapped.execute!(ARGS, {
        toolCallId: `entry-${surface}`,
        messages: [],
        context: {},
      });
      expect(result).toMatchObject({ ok: false, pause: { tool_name: "ask_user_confirm" } });
      const row = await newApproval(before);
      expect(row.args_hash).toBe(expectedHash);
      expect(row.consumed_at).toBeNull();
      expect(await transitionsFor(row.id, conversationId)).toEqual(conversationTransitions);
    });
  }

  test("MCP direct dispatch: same args_hash, approval requested without a conversation transition", async () => {
    const before = await approvalIds(tenantId);
    const envelope = await dispatchTool(
      {
        registry: getUnifiedRegistry(),
        db,
        principal,
        buildMcpStubCtx: () => buildMcpStubCtx({ db, principal }),
        mcpMode: "authoring",
      },
      { surface: "mcp", name: TOOL, args: ARGS },
    );
    expect(envelope.status).toBe("needs_confirm");
    const row = await newApproval(before);
    expect(row.args_hash).toBe(expectedHash);
    expect(row.consumed_at).toBeNull();
    expect(await transitionsFor(row.id, null)).toEqual([AuditAction.APPROVAL_REQUESTED]);
  });

  test("chat surface never reaches the gate: the tool is not in the palette and no approval opens", async () => {
    const before = await approvalIds(tenantId);
    const conversationId = await newConversation();
    const wrapped = await wrapTools(
      toolCtx(conversationId, "chat"),
      freshSignals(),
      [] as TurnEvent[],
      db,
      ["workflow-authoring", "connector-creation-guidance"],
      {},
    );
    expect(Object.keys(wrapped)).not.toContain(TOOL);
    for (const name of Object.keys(wrapped)) {
      expect(CHAT_READONLY_TOOLS.has(name) || name.startsWith("wf_")).toBe(true);
    }
    expect(await approvalIds(tenantId)).toEqual(before);
  });

  test("another tenant sees none of these approvals", async () => {
    expect((await approvalIds(tenantId)).size).toBeGreaterThanOrEqual(LOOP_SURFACES.length + 1);
    expect((await approvalIds(otherTenantId)).size).toBe(0);
  });
});
