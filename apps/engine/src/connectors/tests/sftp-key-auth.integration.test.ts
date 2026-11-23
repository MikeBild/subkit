import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { utils } from "ssh2";
import { auditLog } from "../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../db/tests/setup.ts";
import { seedConnector, seedTenant } from "../../test-helpers/seed.ts";
import { startTestSftpServer, type TestSftpServer } from "../../test-helpers/sftp-server.ts";
import { VAULT_PERMISSION, type VaultViewer } from "../../vault/core/vault-item.ts";
import { createVaultItem } from "../../vault/service.ts";
import { toConnectorView } from "../core/view.ts";
import {
  executeSftpRequest,
  probeSftpConnector,
  SftpConnectorError,
  sftpConnectOptions,
} from "../drivers/sftp.ts";
import type { ConnectorView } from "../types.ts";

const PASSPHRASE = "synthetic-key-passphrase";
const deployKey = utils.generateKeyPairSync("ed25519");
const lockedKey = utils.generateKeyPairSync("ed25519", {
  passphrase: PASSPHRASE,
  cipher: "aes256-ctr",
  rounds: 4,
});
const strangerKey = utils.generateKeyPairSync("ed25519");
const pkcs8Key = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

let ctx: TestDb;
let lockedServer: TestSftpServer;
let server: TestSftpServer;
let tenantA: string;
let tenantB: string;
const admin: VaultViewer = { user_id: null, permissions: new Set(Object.values(VAULT_PERMISSION)) };

async function storeSecret(tenant_id: string, name: string, token: string): Promise<void> {
  await createVaultItem(ctx.db, {
    tenant_id,
    actor: null,
    viewer: admin,
    kind: "secret",
    name,
    scope: "workspace",
    environment: "dev",
    description: null,
    value: { kind: "secret", token },
  });
}

async function keyConnector(
  tenant_id: string,
  target: TestSftpServer,
  auth: Record<string, unknown>,
  pin: string | null = target.host_key_sha256,
): Promise<ConnectorView> {
  const row = await seedConnector(ctx.db, {
    tenant_id,
    driver: "sftp",
    auth_type: "none",
    base_url: `sftp://127.0.0.1:${target.port}/data`,
    config: {
      ...(pin ? { host_key_sha256: pin } : {}),
      auth: { method: "private_key", username: "deploy", ...auth },
    },
  });
  return toConnectorView(row);
}

async function codeOf(connector: ConnectorView, tenant_id: string): Promise<string> {
  try {
    await executeSftpRequest({ db: ctx.db, tenant_id, connector, method: "LIST", path: "/" });
    return "ok";
  } catch (err) {
    if (err instanceof SftpConnectorError) {
      expect(err.message).not.toContain("PRIVATE KEY");
      expect(err.message).not.toContain(PASSPHRASE);
      return err.error_code;
    }
    return (err as { code?: string }).code ?? "other";
  }
}

async function auditText(tenant_id: string): Promise<string> {
  const rows = await ctx.db.execute<{ dump: string }>(
    sql`SELECT coalesce(string_agg(a::text, ' '), '') AS dump FROM audit_log a WHERE a.tenant_id = ${tenant_id}`,
  );
  return rows.rows[0]?.dump ?? "";
}

beforeAll(async () => {
  ctx = await createTestDb("sftp_key_auth");
  tenantA = (await seedTenant(ctx.db, { slug: "sftp-key-a", display_name: "A" })).id;
  tenantB = (await seedTenant(ctx.db, { slug: "sftp-key-b", display_name: "B" })).id;
  server = await startTestSftpServer(["transfer", "synthetic-password"], {
    authorizedKey: { username: "deploy", publicKey: deployKey.public },
  });
  lockedServer = await startTestSftpServer(["transfer", "synthetic-password"], {
    authorizedKey: { username: "deploy", publicKey: lockedKey.public },
  });
  server.files.set("/data/a.csv", Buffer.from("id\n1\n"));
  lockedServer.files.set("/data/b.csv", Buffer.from("id\n2\n"));
  await storeSecret(tenantA, "sftp-deploy-key", deployKey.private);
  await storeSecret(tenantA, "sftp-locked-key", lockedKey.private);
  await storeSecret(tenantA, "sftp-locked-pass", PASSPHRASE);
  await storeSecret(tenantA, "sftp-wrong-pass", "not-the-passphrase");
  await storeSecret(tenantA, "sftp-stranger-key", strangerKey.private);
  await storeSecret(tenantA, "sftp-pkcs8-key", pkcs8Key);
  await storeSecret(tenantA, "sftp-not-a-key", "plain-api-token-1234");
  await storeSecret(
    tenantA,
    "sftp-public-key",
    `-----BEGIN PUBLIC KEY-----\nQUJD\n-----END PUBLIC KEY-----`,
  );
  await storeSecret(tenantA, "sftp-flat-key", deployKey.private.replace(/\n/g, " "));
  await createVaultItem(ctx.db, {
    tenant_id: tenantA,
    actor: null,
    viewer: admin,
    kind: "login",
    name: "sftp-login",
    scope: "workspace",
    environment: "dev",
    description: null,
    value: { kind: "login", username: "deploy", password: "synthetic-login-password" },
  });
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await server?.close();
  await lockedServer?.close();
  await ctx?.cleanup();
}, 30_000);

describe("sftp sign-in with an SSH key from the vault", () => {
  test("lists the folder with the key and records the vault use without the key", async () => {
    const connector = await keyConnector(tenantA, server, { private_key_item: "sftp-deploy-key" });
    const logins = server.publicKeyLogins();
    const res = await executeSftpRequest({
      db: ctx.db,
      tenant_id: tenantA,
      connector,
      method: "LIST",
      path: "/",
    });
    expect(res.entries?.map((entry) => entry.name)).toEqual(["a.csv"]);
    expect(server.publicKeyLogins()).toBe(logins + 1);
    const used = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantA), eq(auditLog.action, "vault.item.used")));
    expect(used.length).toBeGreaterThan(0);
    const dump = await auditText(tenantA);
    const body = deployKey.private.split("\n")[1] as string;
    expect(dump).not.toContain(body);
    expect(dump).not.toContain(PASSPHRASE);
  });

  test("opens an encrypted key with the passphrase from the vault", async () => {
    const connector = await keyConnector(tenantA, lockedServer, {
      private_key_item: "sftp-locked-key",
      passphrase_item: "sftp-locked-pass",
    });
    expect(await codeOf(connector, tenantA)).toBe("ok");
  });

  test("restores a key whose line breaks were lost when it was pasted", async () => {
    const connector = await keyConnector(tenantA, server, { private_key_item: "sftp-flat-key" });
    expect(await codeOf(connector, tenantA)).toBe("ok");
  });

  test("refuses before connecting when the key cannot be used", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ private_key_item: "sftp-missing-key" }, "sftp_key_item_missing"],
      [{ private_key_item: "sftp-login" }, "sftp_key_item_missing"],
      [
        { private_key_item: "sftp-deploy-key", passphrase_item: "sftp-missing-pass" },
        "sftp_key_item_missing",
      ],
      [{ private_key_item: "sftp-not-a-key" }, "sftp_key_not_private_key"],
      [{ private_key_item: "sftp-public-key" }, "sftp_key_not_private_key"],
      [{ private_key_item: "sftp-pkcs8-key" }, "sftp_key_format_unsupported"],
      [{ private_key_item: "sftp-locked-key" }, "sftp_key_passphrase_required"],
      [
        { private_key_item: "sftp-locked-key", passphrase_item: "sftp-wrong-pass" },
        "sftp_key_passphrase_wrong",
      ],
    ];
    const sessions = lockedServer.sessions();
    for (const [auth, code] of cases) {
      const connector = await keyConnector(tenantA, lockedServer, auth);
      expect(await codeOf(connector, tenantA)).toBe(code);
    }
    expect(lockedServer.sessions()).toBe(sessions);
  });

  test("names a key the server refuses without echoing it", async () => {
    const connector = await keyConnector(tenantA, server, {
      private_key_item: "sftp-stranger-key",
    });
    expect(await codeOf(connector, tenantA)).toBe("sftp_key_rejected");
    const probe = await probeSftpConnector({ db: ctx.db, tenant_id: tenantA, connector });
    expect(probe.error_code).toBe("credential_invalid");
    expect(probe.detail).toContain("sftp-stranger-key");
  });

  test("never opens the vault for a connector without a pinned host key", async () => {
    const before = (await auditText(tenantA)).length;
    const connector = await keyConnector(
      tenantA,
      server,
      { private_key_item: "sftp-deploy-key" },
      null,
    );
    expect(await codeOf(connector, tenantA)).toBe("sftp_host_key_missing");
    expect((await auditText(tenantA)).length).toBe(before);
  });

  test("a connector of tenant B cannot use a key stored in the vault of tenant A", async () => {
    const connector = await keyConnector(tenantB, server, { private_key_item: "sftp-deploy-key" });
    const sessions = server.sessions();
    expect(await codeOf(connector, tenantB)).toBe("sftp_key_item_missing");
    expect(server.sessions()).toBe(sessions);
    const probe = await probeSftpConnector({ db: ctx.db, tenant_id: tenantB, connector });
    expect(probe.error_code).toBe("credential_missing");
    expect(await auditText(tenantB)).not.toContain("vault.item.used");
  });
});

describe("sftpConnectOptions", () => {
  test("sends a password or a key with its passphrase, never both", () => {
    expect(
      sftpConnectOptions({ username: "u", secret: { kind: "password", password: "p" } }),
    ).toEqual({ username: "u", password: "p" });
    expect(
      sftpConnectOptions({
        username: "u",
        secret: { kind: "private_key", item: "k", privateKey: "KEY", passphrase: null },
      }),
    ).toEqual({ username: "u", privateKey: "KEY" });
    expect(
      sftpConnectOptions({
        username: "u",
        secret: { kind: "private_key", item: "k", privateKey: "KEY", passphrase: "pw" },
      }),
    ).toEqual({ username: "u", privateKey: "KEY", passphrase: "pw" });
  });
});
