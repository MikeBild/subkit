// Integration tests for the credential-setup grant flow:
//   GET  /v1/connectors/{id}/credentials/setup?grant=sksg_…
//   POST /v1/connectors/{id}/credentials/setup
//
// Mirrors http/routes/connectors/oauth-start-grant.test.ts's coverage shape,
// adapted for the two-hit (validate-then-consume) contract:
//
//   a) mint → GET renders the form and does NOT consume — a second GET with
//      the same grant still returns 200.
//   b) POST with the form fields → consumes the grant, upserts the
//      credential, clears needs_reauth, and renders a thank-you page.
//      grant_issued / grant_consumed audit rows are written.
//   c) POST replay (same grant again) → 400, no second credential write.
//   d) expired grant → 400 (GET and POST).
//   e) valid grant + wrong connector path id → 400 AND grant still claimable
//      at the correct connector id afterwards.
//   f) GET without grant param → 400 (Zod validation), not 401.
//   g) tenant is derived from the grant row — the request carries no bearer
//      token at all.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../../config/loader.ts";
import { generateCredentialSetupGrant } from "../../../connectors/credential-setup-grant.ts";
import { sha256Hex } from "../../../connectors/oauth-start-grant.ts";
import {
  auditLog,
  connectorCredentialSetupGrants,
  connectors,
  conversationElicitations,
  conversations,
  credentials,
} from "../../../db/schema/index.ts";
import { now } from "../../../utils/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let connectorId: string;

beforeAll(async () => {
  server = await createHttpTestServer("credentials-setup-grant");
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });

  const [row] = await server.db
    .insert(connectors)
    .values({
      tenant_id: server.tenantId,
      slug: "mock-setup-bearer",
      display_name: "Mock Setup Bearer",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://mock-setup-bearer.test",
      config: {},
      needs_reauth: true,
      auth_failed_at: new Date(now()),
      auth_failed_reason: "test_seed",
    })
    .returning();
  if (!row) throw new Error("seed connector failed");
  connectorId = row.id;
});

afterAll(async () => {
  await server.cleanup();
});

async function seedGrant(opts?: { expires_at?: Date; connector_id?: string }) {
  const { plaintext, hash } = generateCredentialSetupGrant();
  const expires_at = opts?.expires_at ?? new Date(now() + 5 * 60_000);
  await server.db.insert(connectorCredentialSetupGrants).values({
    tenant_id: server.tenantId,
    connector_id: opts?.connector_id ?? connectorId,
    token_sha256: hash,
    created_by_actor_id: server.userId,
    expires_at,
  });
  return plaintext;
}

async function getGrantRow(token: string) {
  const hash = sha256Hex(token);
  const rows = await server.db
    .select()
    .from(connectorCredentialSetupGrants)
    .where(eq(connectorCredentialSetupGrants.token_sha256, hash))
    .limit(1);
  return rows[0] ?? null;
}

async function getCredentialRow() {
  const rows = await server.db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, server.tenantId),
        eq(credentials.connector_id, connectorId),
        eq(credentials.environment, "dev"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

describe("GET /v1/connectors/{id}/credentials/setup?grant=…", () => {
  test("(a) mint → GET renders the form and does NOT consume", async () => {
    const token = await seedGrant();

    const res = await fetch(
      `${server.baseUrl}/v1/connectors/${connectorId}/credentials/setup?grant=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="token"');
    expect(html).toContain(`value="${token}"`);

    // Grant row must still exist — GET validates only, never consumes.
    expect(await getGrantRow(token)).not.toBeNull();

    // A second GET with the same grant must still succeed.
    const res2 = await fetch(
      `${server.baseUrl}/v1/connectors/${connectorId}/credentials/setup?grant=${encodeURIComponent(token)}`,
    );
    expect(res2.status).toBe(200);
    expect(await getGrantRow(token)).not.toBeNull();
  });

  test("(f) GET without grant param → 400 (Zod validation), not 401", async () => {
    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/credentials/setup`);
    expect(res.status).toBe(400);
  });

  test("(d1) expired grant → 400 HTML", async () => {
    const expiredAt = new Date(now() - 1000);
    const token = await seedGrant({ expires_at: expiredAt });

    const res = await fetch(
      `${server.baseUrl}/v1/connectors/${connectorId}/credentials/setup?grant=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("expired");
  });
});

describe("POST /v1/connectors/{id}/credentials/setup", () => {
  test("(b) valid submission → consumes grant, upserts credential, clears needs_reauth", async () => {
    const token = await seedGrant();
    const [conversation] = await server.db
      .insert(conversations)
      .values({
        tenant_id: server.tenantId,
        owner_id: server.userId,
        status: "awaiting_input",
      })
      .returning();
    if (!conversation) throw new Error("seed conversation failed");
    const [elicitation] = await server.db
      .insert(conversationElicitations)
      .values({
        tenant_id: server.tenantId,
        conversation_id: conversation.id,
        tool_name: "ask_user_confirm",
        summary: "Reconnect connector",
        input: {
          connector_id: connectorId,
          setup_url: `${server.baseUrl}/setup`,
        },
        protocol_native: true,
        delivery_last_error: "url_accepted",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");

    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/credentials/setup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant: token, token: "new-bearer-secret-value" }).toString(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Credential saved");

    // Grant burned.
    expect(await getGrantRow(token)).toBeNull();

    // (g) Credential written under the tenant derived from the grant row —
    // no bearer token was sent on this request at all.
    const cred = await getCredentialRow();
    expect(cred).not.toBeNull();
    expect(cred?.mode).toBe("bearer");
    expect(cred?.tenant_id).toBe(server.tenantId);

    // needs_reauth cleared.
    const [connectorRow] = await server.db
      .select()
      .from(connectors)
      .where(eq(connectors.id, connectorId))
      .limit(1);
    expect(connectorRow?.needs_reauth).toBe(false);

    const [completedElicitation] = await server.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(completedElicitation?.delivery_last_error).toBe("url_completed");

    // grant_consumed audit row present.
    const consumedAudit = await server.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, server.tenantId),
          eq(auditLog.action, "connector.credential_grant.consumed"),
        ),
      );
    expect(consumedAudit.length).toBeGreaterThan(0);

    // (c) Replay: grant is burned, second POST → 400.
    const replay = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/credentials/setup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant: token, token: "another-secret" }).toString(),
    });
    expect(replay.status).toBe(400);
  });

  test("(d2) expired grant → 400 on POST", async () => {
    const expiredAt = new Date(now() - 1000);
    const token = await seedGrant({ expires_at: expiredAt });

    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/credentials/setup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant: token, token: "irrelevant" }).toString(),
    });
    expect(res.status).toBe(400);
  });

  test("(e) valid grant + wrong connector path id → 400 AND grant still claimable at correct id", async () => {
    const token = await seedGrant();

    const [other] = await server.db
      .insert(connectors)
      .values({
        tenant_id: server.tenantId,
        slug: "wrong-connector-for-setup-grant",
        display_name: "Wrong",
        driver: "http",
        environment: "dev",
        auth_type: "bearer",
        base_url: "https://wrong.test",
        config: {},
      })
      .returning();
    if (!other) throw new Error("seed other connector failed");

    const wrongRes = await fetch(`${server.baseUrl}/v1/connectors/${other.id}/credentials/setup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant: token, token: "irrelevant" }).toString(),
    });
    expect(wrongRes.status).toBe(400);

    // Grant must still exist (not burned by the wrong-id attempt).
    expect(await getGrantRow(token)).not.toBeNull();

    // POST with the correct connector id must still succeed.
    const correctRes = await fetch(
      `${server.baseUrl}/v1/connectors/${connectorId}/credentials/setup`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant: token, token: "correct-secret" }).toString(),
      },
    );
    expect(correctRes.status).toBe(200);
    expect(await getGrantRow(token)).toBeNull();
  });
});
