import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { createElicitation } from "../../conversations/elicitations.ts";
import {
  finishConversationTurn,
  reserveConversationTurn,
} from "../../conversations/public/lifecycle.ts";
import * as svc from "../../conversations/service/index.ts";
import {
  apiKeys,
  mcpTasks,
  roles,
  sessions,
  systemAccounts,
  toolApprovals,
  users,
} from "../../db/schema/index.ts";
import { createEngineCtx, type EngineTestCtx } from "../../execution/tests/setup.ts";
import { sha256Hex } from "../../identity/api-key.ts";
import { getMcpTask, insertMcpTask } from "../../mcp/tasks/store.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { openedElicitation } from "../../test-helpers/elicitations.ts";
import { requestApproval } from "../../tools/approval.ts";
import { enqueueApprovalElicitationResume } from "../approval-resume.ts";
import { registerConversationRunTurnHandler } from "../handlers/conversation-run-turn.ts";
import type { ConversationRunTurnJob } from "../queues.ts";

let ctx: EngineTestCtx;
const nextUuid = createDeterministicUuidFactory(941);
let run: (jobs: Job<ConversationRunTurnJob>[]) => Promise<void>;
beforeAll(async () => {
  ctx = await createEngineCtx("conversation-principal-policy");
  const boss = {
    work: async (_name: string, _options: unknown, handler: typeof run) => {
      run = handler;
      return "captured-worker";
    },
  } as unknown as PgBoss;
  await registerConversationRunTurnHandler({ boss, db: ctx.testDb.db });
}, 30_000);
afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, 30_000);

async function fixture() {
  const [user] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: `${nextUuid()}@example.test`,
      role_id: await builtinRoleId(ctx.testDb.db, "admin"),
    })
    .returning();
  if (!user) throw new Error("user missing");
  const [session] = await ctx.testDb.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: user.id,
      expires_at: sql`clock_timestamp() + interval '1 hour'`,
    })
    .returning();
  if (!session) throw new Error("session missing");
  const principal: ResolvedPrincipal = {
    provider: "test",
    kind: "user",
    id: user.id,
    tenant_id: ctx.tenantId,
    roles: ["admin"],
    auth_source: { kind: "browser_session", session_id: session.id },
  };
  const created = await svc.createConversation(
    {
      tenant_id: ctx.tenantId,
      actor_id: user.id,
      initial_message: "queued private operation",
    },
    ctx.testDb.db,
  );
  const taskId = await insertMcpTask(
    {
      tenant_id: ctx.tenantId,
      conversation_id: created.conversation.id,
      actor: { kind: "user", id: user.id },
      request_source: "mcp",
      kind: "start",
      user_message_id: created.initial_message_id,
    },
    ctx.testDb.db,
  );
  const data: ConversationRunTurnJob = {
    tenant_id: ctx.tenantId,
    conversation_id: created.conversation.id,
    mcp_task_id: taskId,
    actor_id: user.id,
    principal,
    kind: "start",
  };
  return { user, session, principal, data, taskId };
}

for (const invalidation of [
  "revoked_session",
  "disabled_user",
  "removed_role",
  "missing_provenance",
]) {
  test(`queued conversation refuses ${invalidation} before invoking tools`, async () => {
    const f = await fixture();
    if (invalidation === "revoked_session")
      await ctx.testDb.db
        .update(sessions)
        .set({ revoked_at: sql`clock_timestamp()` })
        .where(and(eq(sessions.tenant_id, ctx.tenantId), eq(sessions.id, f.session.id)));
    if (invalidation === "removed_role") {
      const [role] = await ctx.testDb.db
        .insert(roles)
        .values({ tenant_id: ctx.tenantId, name: "queued-observer" })
        .returning();
      if (!role) throw new Error("role missing");
      await ctx.testDb.db
        .update(users)
        .set({ role_id: role.id })
        .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, f.user.id)));
    }
    if (invalidation === "disabled_user")
      await ctx.testDb.db
        .update(users)
        .set({ status: "disabled" })
        .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, f.user.id)));
    if (invalidation === "missing_provenance") delete f.principal.auth_source;
    const spy = spyOn(svc, "runConversationTurn");
    try {
      await expect(
        run([{ id: f.taskId, data: f.data } as Job<ConversationRunTurnJob>]),
      ).rejects.toBeDefined();
      expect(spy).not.toHaveBeenCalled();
      expect(
        (await getMcpTask(ctx.tenantId, f.taskId, ctx.testDb.db))?.failure_reason,
      ).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
}

test("a live credential dispatches with current roles rather than serialized roles", async () => {
  const f = await fixture();
  f.principal.roles = ["untrusted-serialized-role"];
  const sentinel = new Error("runner boundary reached");
  const spy = spyOn(svc, "runConversationTurn").mockRejectedValue(sentinel);
  try {
    await expect(run([{ id: f.taskId, data: f.data } as Job<ConversationRunTurnJob>])).rejects.toBe(
      sentinel,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0].principal?.roles).toEqual(["admin"]);
    expect(spy.mock.calls[0]?.[0].principal?.auth_source).toEqual(f.principal.auth_source);
  } finally {
    spy.mockRestore();
  }
});

for (const source of ["api_key", "token_exchange"] as const) {
  test(`queued conversation refuses an invalidated ${source} source`, async () => {
    const f = await fixture();
    const digest = sha256Hex(nextUuid());
    const [key] = await ctx.testDb.db
      .insert(apiKeys)
      .values({
        tenant_id: ctx.tenantId,
        user_id: f.user.id,
        prefix: nextUuid(),
        token_sha256: digest,
        scopes: ["*"],
        ...(source === "api_key" ? { revoked_at: sql`clock_timestamp()` } : {}),
      })
      .returning();
    if (!key) throw new Error("key missing");
    f.principal.auth_source =
      source === "api_key"
        ? { kind: source, api_key_id: key.id, credential_version: sha256Hex(digest) }
        : {
            kind: source,
            api_key_id: key.id,
            credential_version: sha256Hex(digest),
            expires_at: "1970-01-01T00:00:00.000Z",
          };
    const spy = spyOn(svc, "runConversationTurn");
    try {
      await expect(
        run([{ id: f.taskId, data: f.data } as Job<ConversationRunTurnJob>]),
      ).rejects.toBeDefined();
      expect(spy).not.toHaveBeenCalled();
      expect(
        (await getMcpTask(ctx.tenantId, f.taskId, ctx.testDb.db))?.failure_reason,
      ).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
}

for (const invalidation of ["none", "revoked", "missing", "wrong_kind"] as const) {
  test(`portal approved continuation preserves origin with ${invalidation} provenance`, async () => {
    const f = await fixture();
    const approvalId = nextUuid();
    await requestApproval({
      db: ctx.testDb.db,
      principal: f.principal,
      approval_id: approvalId,
      tool: "workflow_save",
      surface: "chat",
      via: "chat",
      reason: "held_writes",
      execution_mode: "dev",
      args: {},
    });
    await ctx.testDb.db
      .update(toolApprovals)
      .set({ granted_at: sql`clock_timestamp()` })
      .where(and(eq(toolApprovals.tenant_id, ctx.tenantId), eq(toolApprovals.id, approvalId)));
    if (invalidation === "revoked")
      await ctx.testDb.db
        .update(sessions)
        .set({ revoked_at: sql`clock_timestamp()` })
        .where(and(eq(sessions.tenant_id, ctx.tenantId), eq(sessions.id, f.session.id)));
    if (invalidation === "missing")
      await ctx.testDb.db
        .update(toolApprovals)
        .set({ caller_context: null, authorization_context: null })
        .where(and(eq(toolApprovals.tenant_id, ctx.tenantId), eq(toolApprovals.id, approvalId)));
    if (invalidation === "wrong_kind") {
      await ctx.testDb.db
        .insert(systemAccounts)
        .values({ id: f.user.id, tenant_id: ctx.tenantId, name: "same identifier different kind" });
      await ctx.testDb.db
        .update(toolApprovals)
        .set({
          caller_context: {
            tenantId: ctx.tenantId,
            principalId: f.user.id,
            principalKind: "system_account",
            productId: null,
            provider: "test",
          },
        })
        .where(and(eq(toolApprovals.tenant_id, ctx.tenantId), eq(toolApprovals.id, approvalId)));
    }
    const elicitation = openedElicitation(
      await createElicitation(
        {
          tenant_id: ctx.tenantId,
          conversation_id: f.data.conversation_id,
          tool_call_id: null,
          tool_name: "ask_user_text",
          summary: "approved action",
          input: {},
          actor_id: f.user.id,
        },
        ctx.testDb.db,
      ),
    );
    let captured: ConversationRunTurnJob | undefined;
    const boss = {
      send: async (_queue: string, data: ConversationRunTurnJob, options: { id: string }) => {
        captured = data;
        return options.id;
      },
    } as unknown as PgBoss;
    const queued = await enqueueApprovalElicitationResume(
      {
        tenant_id: ctx.tenantId,
        conversation_id: f.data.conversation_id,
        elicitation_id: elicitation.id,
        approval_id: approvalId,
        approver_user_id: f.user.id,
        decision: "approve",
      },
      ctx.testDb.db,
      boss,
    );
    expect(queued).toBe(invalidation === "none");
    if (invalidation !== "none") {
      expect(captured).toBeUndefined();
      return;
    }
    expect(captured?.principal?.auth_source).toEqual(f.principal.auth_source);
    expect(captured?.principal?.kind).toBe("user");
    const sentinel = new Error("approved original principal reached runner");
    const spy = spyOn(svc, "respondElicitation").mockRejectedValue(sentinel);
    try {
      await expect(
        run([{ id: captured?.attempt_id, data: captured } as Job<ConversationRunTurnJob>]),
      ).rejects.toBe(sentinel);
      expect(spy.mock.calls[0]?.[0].principal?.auth_source).toEqual(f.principal.auth_source);
    } finally {
      spy.mockRestore();
    }
  });
}

test("portal approval that arrives while the asking turn still runs is queued once it ends", async () => {
  const f = await fixture();
  const approvalId = nextUuid();
  await requestApproval({
    db: ctx.testDb.db,
    principal: f.principal,
    approval_id: approvalId,
    tool: "workflow_save",
    surface: "chat",
    via: "chat",
    reason: "held_writes",
    execution_mode: "dev",
    args: {},
  });
  await ctx.testDb.db
    .update(toolApprovals)
    .set({ granted_at: sql`clock_timestamp()` })
    .where(and(eq(toolApprovals.tenant_id, ctx.tenantId), eq(toolApprovals.id, approvalId)));
  const elicitation = openedElicitation(
    await createElicitation(
      {
        tenant_id: ctx.tenantId,
        conversation_id: f.data.conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_text",
        summary: "approved action",
        input: {},
        actor_id: f.user.id,
      },
      ctx.testDb.db,
    ),
  );
  const asking = await reserveConversationTurn(ctx.testDb.db, ctx.tenantId, f.data.conversation_id);
  let sent = 0;
  const boss = {
    send: async (_queue: string, _data: ConversationRunTurnJob, options: { id: string }) => {
      sent += 1;
      return options.id;
    },
  } as unknown as PgBoss;
  const queued = enqueueApprovalElicitationResume(
    {
      tenant_id: ctx.tenantId,
      conversation_id: f.data.conversation_id,
      elicitation_id: elicitation.id,
      approval_id: approvalId,
      approver_user_id: f.user.id,
      decision: "approve",
    },
    ctx.testDb.db,
    boss,
  );
  await waitFor(
    async () => {
      const [task] = await ctx.testDb.db
        .select({ job_id: mcpTasks.job_id })
        .from(mcpTasks)
        .where(
          and(
            eq(mcpTasks.tenant_id, ctx.tenantId),
            eq(mcpTasks.conversation_id, f.data.conversation_id),
            eq(mcpTasks.kind, "respond_elicitation"),
          ),
        );
      return task?.job_id ?? null;
    },
    { label: "continuation prepared while the asking turn runs" },
  );
  expect(sent).toBe(0);
  await finishConversationTurn(ctx.testDb.db, ctx.tenantId, f.data.conversation_id, asking);
  expect(await queued).toBe(true);
  expect(sent).toBe(1);
});
