// Integration test A.1 — end-to-end re-issue flow for a non-OAuth connector
// that has been flagged `needs_reauth`.
//
// Coverage:
//   1. Seed a saved Basic connector, mark needs_reauth.
//   2. Call request_connector_reauth → draft acquires saved_connector_id +
//      mode credential_re_issue.
//   3. Drive the re-issue credential save (saveConnectorAtomic re-issue path
//      with a rotated basic credential).
//   4. Assert: (a) connector id unchanged, (b) credential row updated,
//      (c) connectors.needs_reauth=false AND auth_failed_at IS NULL,
//      (d) a credential_rotated audit row exists.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { markConnectorNeedsReauth } from "../../connectors/reauth.ts";
import { auditLog, connectors, credentials, users } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createRole, grantPermissionToRole } from "../../rbac/roles.ts";
import { createConversation } from "../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import { requestConnectorReauthTool } from "../tools/request-connector-reauth.ts";
import type { DraftDocument } from "../types.ts";
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
    permission_mode: null,
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

    // Mark the connector as needing re-auth (simulates a dead credential).
    await markConnectorNeedsReauth(ctx.testDb.db, ctx.tenant_id, connectorId, "token_expired");

    // Verify the flag is set.
    const [before] = await ctx.testDb.db
      .select({ needs_reauth: connectors.needs_reauth, auth_failed_at: connectors.auth_failed_at })
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    expect(before?.needs_reauth).toBe(true);
    expect(before?.auth_failed_at).not.toBeNull();

    // Step 1: request_connector_reauth for the non-OAuth connector.
    const { toolCtx } = await makeToolCtx();
    const reauth = await requestConnectorReauthTool.execute(toolCtx, { connector_id: connectorId });
    expect(reauth.ok).toBe(true);
    const reauthData = reauth.data as {
      method: string;
      mode?: string;
      next_best_actions?: string[];
    };
    // Non-OAuth → portal_setup method, credential_re_issue mode.
    expect(reauthData.method).toBe("portal_setup");
    expect(reauthData.mode).toBe("credential_re_issue");
    expect(reauthData.next_best_actions).toContain("ask_user_form");

    // Draft must now have saved_connector_id set.
    const draftAfterReauth = toolCtx.getDraft();
    expect(draftAfterReauth.connector?.saved_connector_id).toBe(connectorId);

    // Step 2: drive saveConnectorAtomic in re-issue mode with a rotated credential.
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

    // (a) Connector id unchanged — the re-issue path updates the same row.
    expect(saveData.connector.id).toBe(connectorId);

    // (b) Credential row was written.
    expect(saveData.credential_persisted).toBe(true);
    const credRows = await ctx.testDb.db
      .select()
      .from(credentials)
      .where(
        and(eq(credentials.tenant_id, ctx.tenant_id), eq(credentials.connector_id, connectorId)),
      );
    expect(credRows.length).toBeGreaterThan(0);

    // (c) needs_reauth cleared, auth_failed_at is NULL.
    const [after] = await ctx.testDb.db
      .select({ needs_reauth: connectors.needs_reauth, auth_failed_at: connectors.auth_failed_at })
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    expect(after?.needs_reauth).toBe(false);
    expect(after?.auth_failed_at).toBeNull();

    // (d) A credential_rotated audit row must exist for this connector.
    const auditRows = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.resource_id, connectorId)))
      .orderBy(desc(auditLog.ts));
    const rotatedRow = auditRows.find(
      (r) => (r.metadata as { kind?: string }).kind === "credential_rotated",
    );
    expect(rotatedRow).toBeDefined();

    // clearConnectorReauth self-audits the true→false transition, so the
    // needs_reauth clear carries its own row independent of the credential
    // rotation — the audit is structural, not comment-enforced.
    const reauthClearedRow = auditRows.find((r) => r.action === "connector.reauth_cleared");
    expect(reauthClearedRow).toBeDefined();
  });

  test("wrong tenant cannot re-issue: connector not found for a different tenant", async () => {
    const connectorId = await seedBasicConnector("basic-reauth-cross-tenant");

    // Create a context for a fake tenant that does NOT own the connector.
    const fakeTenantCtx = {
      db: ctx.testDb.db,
      tenant_id: "00000000-0000-0000-0000-000000000000", // wrong tenant
      conversation_id: crypto.randomUUID(), // allow-random: test isolation
      actor_id: ctx.user_id,
      connector_id: null,
      workflow_id: null,
      permission_mode: null,
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
    // The connector exists but belongs to a different tenant — should return not found.
    expect(result.ok).toBe(false);
    const err = result as { error_code?: string };
    expect(err.error_code).toBe("connector_not_found");
  });

  // In-tenant RBAC: the tool now requires connector:write (it stages a
  // credential rotation). A member who can READ the connector but lacks
  // connector:write must be denied — and the draft must NOT be staged.
  // (The more likely real-world failure mode than the cross-tenant case.)
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
        role: "member",
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
      permission_mode: null,
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

    const result = await requestConnectorReauthTool.execute(memberCtx, {
      connector_id: connectorId,
    });
    expect(result.ok).toBe(false);
    const err = result as { error_code?: string; permission?: string };
    expect(err.error_code).toBe("permission_denied");
    expect(err.permission).toBe("connector:write");
    // The re-issue draft must NOT have been staged for an unauthorised principal.
    expect(draft.connector?.saved_connector_id).toBeUndefined();
  });
});
