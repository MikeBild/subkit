import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { markConnectorNeedsReauth } from "../../connectors/reauth.ts";
import { auditLog, connectors, users, vaultItems } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createRole, grantPermissionToRole } from "../../rbac/roles.ts";
import { createConversation } from "../service/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import { checkToolPermission } from "../tools/permission-gate.ts";
import { requestConnectorReauthTool } from "../tools/request-connector-reauth.ts";
import type { DraftDocument } from "../types.ts";
import { persistCredential } from "./persist-credential.ts";
import { saveConnectorAtomic } from "./save-connector.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("reauth_reissue");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedBasicConnector(slug: string): Promise<string> {
  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenant_id,
      slug,
      display_name: slug,
      driver: "http",
      environment: "dev",
      auth_type: "basic",
      base_url: "https://api.example.test",
      config: {},
    })
    .returning();
  if (!c) throw new Error("seed connector failed");
  return c.id;
}

async function makeToolCtx(connectorId?: string | null) {
  const created = await createConversation(
    { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, title: "reauth-test" },
    ctx.testDb.db,
  );
  let draft: DraftDocument = { workflow: { name: "", steps: [] } };
  const toolCtx = {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: created.conversation.id,
    actor_id: ctx.user_id,
    connector_id: connectorId ?? null,
    workflow_id: null,
    ask_before_writing: true,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      actor_type: "user",
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
  };
  return { toolCtx, conversation_id: created.conversation.id };
}

describe("request_connector_reauth + credential re-issue", () => {
  test("non-OAuth basic connector: reauth binds draft, save rotates credential + clears needs_reauth", async () => {
    const connectorId = await seedBasicConnector("basic-reauth-api");

    await markConnectorNeedsReauth(ctx.testDb.db, ctx.tenant_id, connectorId, "token_expired");

    const [before] = await ctx.testDb.db
      .select({ needs_reauth: connectors.needs_reauth, auth_failed_at: connectors.auth_failed_at })
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    expect(before?.needs_reauth).toBe(true);
    expect(before?.auth_failed_at).not.toBeNull();

    const { toolCtx } = await makeToolCtx();
    const reauth = await requestConnectorReauthTool.execute(toolCtx, { connector_id: connectorId });
    expect(reauth.ok).toBe(true);
    const reauthData = reauth.data as {
      method: string;
      mode?: string;
      next_best_actions?: string[];
    };
    expect(reauthData.method).toBe("portal_setup");
    expect(reauthData.mode).toBe("credential_re_issue");
    expect(reauthData.next_best_actions).toContain("ask_user_form");

    const draftAfterReauth = toolCtx.getDraft();
    expect(draftAfterReauth.connector?.saved_connector_id).toBe(connectorId);

    const saveResult = await saveConnectorAtomic({
      ctx: toolCtx,
      environment: "dev",
      credential: { mode: "basic", username: "user@example.com", password: "new-rotated-password" },
      emitAutoPersistAudit: true,
      reason: "auto_persist_on_confirmation",
      commitIntentKind: "save_connector_draft",
    });
    expect(saveResult.ok).toBe(true);
    const saveData = saveResult.data as {
      connector: { id: string };
      credential_persisted: boolean;
    };

    expect(saveData.connector.id).toBe(connectorId);

    expect(saveData.credential_persisted).toBe(true);
    const credRows = await ctx.testDb.db
      .select()
      .from(vaultItems)
      .where(
        and(eq(vaultItems.tenant_id, ctx.tenant_id), eq(vaultItems.connector_id, connectorId)),
      );
    expect(credRows.length).toBeGreaterThan(0);

    const [after] = await ctx.testDb.db
      .select({ needs_reauth: connectors.needs_reauth, auth_failed_at: connectors.auth_failed_at })
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    expect(after?.needs_reauth).toBe(false);
    expect(after?.auth_failed_at).toBeNull();

    const auditRows = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.resource_id, connectorId)))
      .orderBy(desc(auditLog.ts));
    const rotatedRow = auditRows.find(
      (r) => (r.metadata as { kind?: string }).kind === "credential_rotated",
    );
    expect(rotatedRow).toBeDefined();

    const reauthClearedRow = auditRows.find((r) => r.action === "connector.reauth_cleared");
    expect(reauthClearedRow).toBeDefined();
  });

  test.each([undefined, "client-secret"])(
    "MCP client setup preserves reauth and replays concurrent saves (%s)",
    async (client_secret) => {
      const connectorId = await seedBasicConnector(
        `mcp-client-reauth-${client_secret ? "confidential" : "public"}`,
      );
      await ctx.testDb.db
        .update(connectors)
        .set({
          driver: "mcp",
          circuit_state: "open",
          circuit_failure_count: 5,
          auth_type: "oauth2",
          config: { mcp: { auth: { kind: "oauth2" } } },
        })
        .where(eq(connectors.id, connectorId));
      await markConnectorNeedsReauth(ctx.testDb.db, ctx.tenant_id, connectorId, "token_expired");
      const { toolCtx } = await makeToolCtx(connectorId);
      await toolCtx.setDraft({
        workflow: { name: "", steps: [] },
        connector: { saved_connector_id: connectorId },
      });
      const save = () =>
        saveConnectorAtomic({
          ctx: toolCtx,
          environment: "dev",
          credential: {
            mode: "oauth2",
            client_id: "registered-client",
            ...(client_secret ? { client_secret } : {}),
          },
        });
      const results = await Promise.all([save(), save(), save()]);
      expect(results.every((result) => result.ok)).toBe(true);
      const [after] = await ctx.testDb.db
        .select()
        .from(connectors)
        .where(eq(connectors.id, connectorId));
      expect(after?.needs_reauth).toBe(true);
      expect(after?.auth_failed_reason).toBe("token_expired");
      expect(after?.circuit_state).toBe("open");
      expect(after?.circuit_failure_count).toBe(5);
      await ctx.testDb.db
        .update(connectors)
        .set({ config: { mcp: { auth: { kind: "oauth2", client_id: "newer-client" } } } })
        .where(eq(connectors.id, connectorId));
      expect((await save()).ok).toBe(true);
      const [replayed] = await ctx.testDb.db
        .select()
        .from(connectors)
        .where(eq(connectors.id, connectorId));
      expect(replayed?.config).toEqual({
        mcp: { auth: { kind: "oauth2", client_id: "newer-client" } },
      });
      const receipts = await ctx.testDb.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.resource_id, connectorId),
            eq(auditLog.action, "connector.mcp_client_saved"),
          ),
        );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.trace_id).toBe(toolCtx.conversation_id);
      expect(receipts[0]?.metadata).toEqual({ credential_persisted: true });
    },
  );

  test.each([undefined, "client-secret"])(
    "MCP command edits survive saving OAuth client credentials (%s)",
    async (client_secret) => {
      const connectorId = await seedBasicConnector(
        `mcp-command-edit-${client_secret ? "confidential" : "public"}`,
      );
      const oldConfig = {
        mcp: { transport: "stdio", command: "node", args: ["old.js"] },
      };
      const currentConfig = {
        mcp: {
          transport: "stdio",
          command: "bun",
          args: ["new.ts"],
          auth: { kind: "oauth2", issuer: "https://issuer.example.test" },
        },
      };
      await ctx.testDb.db
        .update(connectors)
        .set({ driver: "mcp", config: currentConfig })
        .where(eq(connectors.id, connectorId));
      const result = await persistCredential({
        db: ctx.testDb.db,
        tenant_id: ctx.tenant_id,
        connector_id: connectorId,
        actor_id: ctx.user_id,
        correlation_id: connectorId,
        driver: "mcp",
        connectorConfig: oldConfig,
        environment: "dev",
        credential: {
          mode: "oauth2",
          client_id: "registered-client",
          ...(client_secret ? { client_secret } : {}),
        },
      });
      expect(result?.credential_persisted).toBe(true);
      const [after] = await ctx.testDb.db
        .select({ config: connectors.config })
        .from(connectors)
        .where(eq(connectors.id, connectorId));
      expect(after?.config).toEqual({
        mcp: {
          transport: "stdio",
          command: "bun",
          args: ["new.ts"],
          auth: {
            kind: "oauth2",
            issuer: "https://issuer.example.test",
            client_id: "registered-client",
          },
        },
      });
    },
  );

  test("wrong tenant cannot re-issue: connector not found for a different tenant", async () => {
    const connectorId = await seedBasicConnector("basic-reauth-cross-tenant");

    const fakeTenantCtx = {
      db: ctx.testDb.db,
      tenant_id: "00000000-0000-0000-0000-000000000000",
      conversation_id: crypto.randomUUID(), // allow-random: test isolation
      actor_id: ctx.user_id,
      connector_id: null,
      workflow_id: null,
      ask_before_writing: true,
      engineClient: new EngineClient({
        tenant_id: "00000000-0000-0000-0000-000000000000",
        actor_id: ctx.user_id,
        actor_type: "user",
        db: ctx.testDb.db,
      }),
      getDraft: (): DraftDocument => ({ workflow: { name: "", steps: [] } }),
      setDraft: async () => {},
    };

    const result = await requestConnectorReauthTool.execute(fakeTenantCtx, {
      connector_id: connectorId,
    });
    expect(result.ok).toBe(false);
    const err = result as { error_code?: string };
    expect(err.error_code).toBe("connector_not_found");
  });

  test("in-tenant principal with connector:read but not connector:write is denied", async () => {
    const connectorId = await seedBasicConnector("basic-reauth-rbac-deny");

    const role = await createRole(
      ctx.testDb.db,
      ctx.tenant_id,
      "reauth_reader_only",
      "can read connectors but not write them",
    );
    await grantPermissionToRole(ctx.testDb.db, ctx.tenant_id, role.id, "connector:read");

    const [member] = await ctx.testDb.db
      .insert(users)
      .values({
        tenant_id: ctx.tenant_id,
        email: "reauth-reader-only@example.test",
        role_id: role.id,
      })
      .returning();
    if (!member) throw new Error("seed member failed");

    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: member.id, title: "rbac-deny-test" },
      ctx.testDb.db,
    );
    let draft: DraftDocument = { workflow: { name: "", steps: [] } };
    const memberCtx = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: created.conversation.id,
      actor_id: member.id,
      connector_id: null,
      workflow_id: null,
      ask_before_writing: true,
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: member.id,
        actor_type: "user",
        db: ctx.testDb.db,
      }),
      getDraft: () => draft,
      setDraft: async (next: DraftDocument) => {
        draft = next;
      },
    };

    const perm = requestConnectorReauthTool.permission;
    if (!perm) throw new Error("request_connector_reauth lost its permission descriptor");
    const check = await checkToolPermission(memberCtx, perm, { connector_id: connectorId });
    expect(check.allow).toBe(false);
    if (!check.allow) {
      expect(check.permission).toBe("connector:write");
      const result = perm.denyResult?.(check.permission, check.reason);
      const err = result as { ok?: boolean; error_code?: string; permission?: string };
      expect(err.ok).toBe(false);
      expect(err.error_code).toBe("permission_denied");
      expect(err.permission).toBe("connector:write");
    }
    expect(draft.connector?.saved_connector_id).toBeUndefined();
  });
});
