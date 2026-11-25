import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/index.ts";
import { _resetConfigForTests, getConfig, loadConfig } from "../../config/loader.ts";
import { encryptSecret } from "../../crypto/index.ts";
import { withTenantScope } from "../../db/index.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { apiKeys, chatIdentities, chatWorkspaces, systemAccounts } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getRuntimeConfigState, initializeRuntimeConfig } from "../../runtime-config/service.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import {
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
} from "../tests/setup.ts";

let server: HttpTestServer;
let configDir: string;
let previousNodeEnv: string | undefined;

beforeAll(async () => {
  previousNodeEnv = testEnv.NODE_ENV;
  testEnv.NODE_ENV = "test";
  configDir = mkdtempSync(join(tmpdir(), "subkit-chat-signing-revision-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/chat-signing-revision", NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  server = await createHttpTestServer("chat-ws-signing-revision");
  await initializeRuntimeConfig(server.db, getConfig());
});

afterAll(async () => {
  await server.cleanup();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  if (previousNodeEnv === undefined) delete testEnv.NODE_ENV;
  else testEnv.NODE_ENV = previousNodeEnv;
});

function call(path: string, init: RequestInit = {}, key = server.apiKey): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}

async function saveSigningSecretAndRestart(value: string, force: boolean): Promise<number> {
  testEnv.NODE_ENV = "production";
  try {
    const saved = await call("/v1/settings/platform.slack.signing_secret", {
      method: "PUT",
      body: JSON.stringify({ value, ...(force ? { force: true } : {}) }),
    });
    expect([200, 409]).toContain(saved.status);
  } finally {
    testEnv.NODE_ENV = "test";
  }
  const restarted = await initializeRuntimeConfig(server.db, getConfig());
  expect(restarted.active_revision).toBe(restarted.saved_revision);
  return restarted.active_revision;
}

async function install(body: Record<string, unknown>): Promise<Response> {
  return call("/v1/chat/workspaces", { method: "POST", body: JSON.stringify(body) });
}

async function readback() {
  const workspaces = (await (await call("/v1/chat/workspaces")).json()) as {
    items: { workspace_id: string }[];
  };
  const identities = (await (await call("/v1/chat/identities")).json()) as {
    items: { platform_user_id: string }[];
  };
  return { workspaces: workspaces.items, identities: identities.items };
}

describe("POST /v1/chat/workspaces after an active Slack signing revision (#593)", () => {
  test("install with and without default channel returns 201 once the restart-required revision is active", async () => {
    const before = await getRuntimeConfigState(server.db);
    const active = await saveSigningSecretAndRestart("slack-signing-secret-593-a", true);
    expect(active).toBeGreaterThan(before.active_revision);
    expect(getConfig().platform.slack.signing_secret).toBe("slack-signing-secret-593-a");

    const withChannel = await install({
      platform: "slack",
      workspace_id: "T593A",
      installer_platform_user_id: "U593A",
      bot_token: "xoxb-593-a",
      default_channel: "C593A",
    });
    expect(withChannel.status).toBe(201);

    const withoutChannel = await install({
      platform: "slack",
      workspace_id: "T593B",
      installer_platform_user_id: "U593B",
      bot_token: "xoxb-593-b",
    });
    expect(withoutChannel.status).toBe(201);

    const { workspaces, identities } = await readback();
    expect(workspaces.map((row) => row.workspace_id).sort()).toEqual(["T593A", "T593B"]);
    expect(identities.map((row) => row.platform_user_id).sort()).toEqual(["U593A", "U593B"]);
  });

  test("a save without force that waits for the restart also installs after the restart", async () => {
    await saveSigningSecretAndRestart("slack-signing-secret-593-c", false);
    expect(getConfig().platform.slack.signing_secret).toBe("slack-signing-secret-593-c");
    const res = await install({
      platform: "slack",
      workspace_id: "T593C",
      installer_platform_user_id: "U593C",
      bot_token: "xoxb-593-c",
    });
    expect(res.status).toBe(201);
  });

  test("concurrent installs of distinct and identical workspaces never answer 500", async () => {
    const responses = await Promise.all([
      install({
        platform: "slack",
        workspace_id: "T593D",
        installer_platform_user_id: "U593D",
        bot_token: "xoxb-593-d",
        default_channel: "C593D",
      }),
      install({
        platform: "slack",
        workspace_id: "T593D",
        installer_platform_user_id: "U593D",
        bot_token: "xoxb-593-d",
      }),
      install({
        platform: "slack",
        workspace_id: "T593E",
        installer_platform_user_id: "U593E",
        bot_token: "xoxb-593-e",
      }),
      install({
        platform: "slack",
        workspace_id: "T593F",
        installer_platform_user_id: "U593E",
        bot_token: "xoxb-593-f",
      }),
    ]);
    const statuses = responses.map((res) => res.status);
    expect(statuses).not.toContain(500);
    expect(statuses.filter((status) => status === 201).length).toBeGreaterThanOrEqual(3);
    const rows = await server.db.select().from(chatWorkspaces);
    expect(rows.filter((row) => row.workspace_id === "T593D")).toHaveLength(1);
    const links = await server.db.select().from(chatIdentities);
    expect(links.filter((row) => row.platform_user_id === "U593D")).toHaveLength(1);
  });

  test("an install racing an uncommitted claim of the same workspace in another tenant answers 409", async () => {
    const secondary = await createSecondaryTenant(server, "chat-install-race");
    const placeholder = encryptSecret("__placeholder__");
    const claimed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withTenantScope(server.db, secondary.tenantId, async (tx) => {
      await tx.insert(chatWorkspaces).values({
        tenant_id: secondary.tenantId,
        platform: "slack",
        workspace_id: "T593H",
        bot_ciphertext: placeholder.ciphertext,
        bot_iv: placeholder.iv,
        bot_auth_tag: placeholder.auth_tag,
      });
      claimed.resolve();
      await release.promise;
    });
    await claimed.promise;
    const installing = install({
      platform: "slack",
      workspace_id: "T593H",
      installer_platform_user_id: "U593H",
      bot_token: "xoxb-593-h",
    });
    const settled = Promise.allSettled([holder, installing]);
    try {
      await waitFor(
        async () => {
          const result = await server.testDb.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%insert into%chat_workspaces%'",
          );
          return Number(result.rows[0]?.count) > 0;
        },
        { label: "install blocked on the uncommitted foreign claim", tries: 5000 },
      );
    } finally {
      release.resolve();
      await settled;
    }
    const res = await installing;
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.message).toContain("another tenant");
    const rows = await server.db
      .select()
      .from(chatWorkspaces)
      .where(eq(chatWorkspaces.workspace_id, "T593H"));
    expect(rows.map((row) => row.tenant_id)).toEqual([secondary.tenantId]);
    const links = await server.db
      .select()
      .from(chatIdentities)
      .where(eq(chatIdentities.platform_user_id, "U593H"));
    expect(links).toHaveLength(0);
    const denied = await server.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, AuditAction.CHAT_WORKSPACE_INSTALLED),
          eq(auditLog.reason, "workspace_already_claimed"),
        ),
      );
    expect(denied).toHaveLength(1);
  });

  test("the bootstrap system-account key is refused with 403 instead of a 500 and leaves no rows", async () => {
    await server.db
      .update(systemAccounts)
      .set({ role_id: await builtinRoleId(server.db, "admin") })
      .where(eq(systemAccounts.id, server.systemAccountId));
    const machineKey = "wf_live_SYS_chat_install_593_000000000000";
    await server.db.insert(apiKeys).values({
      tenant_id: server.tenantId,
      system_account_id: server.systemAccountId,
      prefix: machineKey.slice(0, 12),
      token_sha256: createHash("sha256").update(machineKey).digest("hex"),
      scopes: ["*"],
    });
    for (const defaultChannel of ["C593G", undefined]) {
      const res = await call(
        "/v1/chat/workspaces",
        {
          method: "POST",
          body: JSON.stringify({
            platform: "slack",
            workspace_id: "T593G",
            installer_platform_user_id: "U593G",
            bot_token: "xoxb-593-g",
            ...(defaultChannel ? { default_channel: defaultChannel } : {}),
          }),
        },
        machineKey,
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("forbidden");
      expect(body.message).toContain("system account");
    }
    const rows = await server.db
      .select()
      .from(chatWorkspaces)
      .where(eq(chatWorkspaces.workspace_id, "T593G"));
    expect(rows).toHaveLength(0);
    const links = await server.db
      .select()
      .from(chatIdentities)
      .where(eq(chatIdentities.platform_user_id, "U593G"));
    expect(links).toHaveLength(0);
    const denied = await server.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, AuditAction.CHAT_WORKSPACE_INSTALLED),
          eq(auditLog.reason, "installer_not_user"),
        ),
      );
    expect(denied).toHaveLength(2);
    expect(denied[0]?.actor_type).toBe("system_account");
  });
});
