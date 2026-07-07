// HTTP integration tests for the install-time hardening guards on
// `POST /v1/chat/workspaces` (apps/engine/src/http/routes/chat-workspaces.ts):
//
//   - `teams` is rejected outright — no adapter is hydrated for it, so
//     an install row would squat the global (platform, workspace_id)
//     slot against a real future install.
//   - `google_chat` (a tenant-GLOBAL-id platform) requires the caller
//     to already own the claimed `installer_platform_user_id` via an
//     existing verified `chat_identities` row — otherwise a caller
//     could bind a victim's People-id to their own subkit user and
//     hijack the victim's future DMs.
//
// Slack is skipped (per the task): a live install additionally needs
// `platform.slack.signing_secret` configured, which is orthogonal to
// the guard under test here.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/index.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { chatIdentities, chatWorkspaces } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("chat-ws-install-guard");
});

afterAll(async () => {
  // allow-wall-clock: real ms required to flush postgres write queue.
  await new Promise((r) => setTimeout(r, 250));
  // allow-wall-clock: wall-clock cap on cleanup to avoid Bun's 5s afterAll timeout.
  await Promise.race([ctx.cleanup(), new Promise<void>((r) => setTimeout(r, 4000))]);
}, 10_000);

async function findWorkspace(workspaceId: string) {
  const rows = await ctx.db
    .select()
    .from(chatWorkspaces)
    .where(
      and(eq(chatWorkspaces.tenant_id, ctx.tenantId), eq(chatWorkspaces.workspace_id, workspaceId)),
    );
  return rows;
}

async function findDeniedInstallAudit(reason: string) {
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, AuditAction.CHAT_WORKSPACE_INSTALLED),
        eq(auditLog.result, "denied"),
        eq(auditLog.reason, reason),
      ),
    );
  return rows;
}

describe("POST /v1/chat/workspaces — install hardening", () => {
  test("400 — platform:teams is rejected (no hydrated adapter)", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/workspaces`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        platform: "teams",
        workspace_id: "teams-ws-1",
        installer_platform_user_id: "user-teams-1",
        bot_token: "teams-bot-token",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("bad_request");
    expect(body.message).toContain("teams chat spaces are not supported yet");

    const denied = await findDeniedInstallAudit("platform_unsupported");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.metadata).toMatchObject({
      platform: "teams",
      workspace_id: "teams-ws-1",
    });

    const rows = await findWorkspace("teams-ws-1");
    expect(rows).toHaveLength(0);
  });

  test("403 — google_chat installer_platform_user_id not owned by caller", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/workspaces`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        platform: "google_chat",
        workspace_id: "spaces/NOTOWNED1",
        installer_platform_user_id: "users/not-mine",
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");

    const denied = await findDeniedInstallAudit("installer_not_owned");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.metadata).toMatchObject({
      platform: "google_chat",
      workspace_id: "spaces/NOTOWNED1",
      installer_platform_user_id: "users/not-mine",
    });

    const rows = await findWorkspace("spaces/NOTOWNED1");
    expect(rows).toHaveLength(0);
  });

  test("201 — google_chat installer_platform_user_id owned by caller installs", async () => {
    // Proof of ownership: an existing verified chat_identities row for
    // THIS caller, bootstrapped (in production) by the JWT-verified
    // DM auto-register path.
    await ctx.db.insert(chatIdentities).values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      platform: "google_chat",
      workspace_id: "spaces/PRE-DM",
      platform_user_id: "users/owned-1",
    });

    const res = await fetch(`${ctx.baseUrl}/v1/chat/workspaces`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        platform: "google_chat",
        workspace_id: "spaces/OWNED1",
        installer_platform_user_id: "users/owned-1",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      tenant_id: string;
      platform: string;
      workspace_id: string;
    };
    expect(body.platform).toBe("google_chat");
    expect(body.workspace_id).toBe("spaces/OWNED1");
    expect(body.tenant_id).toBe(ctx.tenantId);

    const rows = await findWorkspace("spaces/OWNED1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(body.id);

    const success = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, AuditAction.CHAT_WORKSPACE_INSTALLED),
          eq(auditLog.result, "success"),
          eq(auditLog.resource_id, body.id),
        ),
      );
    expect(success).toHaveLength(1);
  });
});
