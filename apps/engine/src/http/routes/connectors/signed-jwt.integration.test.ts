import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { exportPKCS8, generateKeyPair } from "jose";
import { generateCredentialSetupGrant } from "../../../connectors/credential-setup-grant.ts";
import { getCredentialForConnector } from "../../../credentials/service.ts";
import {
  connectorCredentialSetupGrants,
  connectors,
  vaultItems,
} from "../../../db/schema/index.ts";
import { now } from "../../../utils/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let connectorId: string;
let privateKey: string;
const config = {
  signed_jwt: {
    algorithm: "ES256",
    audience: "fixture-api",
    issuer: "fixture-issuer",
    key_id: "fixture-key",
    ttl_seconds: 300,
  },
};

beforeAll(async () => {
  server = await createHttpTestServer("signed-jwt-setup");
  privateKey = await exportPKCS8(
    (await generateKeyPair("ES256", { extractable: true })).privateKey,
  );
  const [connector] = await server.db
    .insert(connectors)
    .values({
      tenant_id: server.tenantId,
      slug: "signed-jwt-fixture",
      display_name: "Signed JWT fixture",
      driver: "http",
      environment: "dev",
      auth_type: "signed_jwt",
      base_url: "https://provider.example.test",
      config,
    })
    .returning();
  if (!connector) throw new Error("fixture connector missing");
  connectorId = connector.id;
});

afterAll(async () => {
  await server.cleanup();
});

async function attach(key: string) {
  return await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/credentials`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ mode: "signed_jwt", private_key: key }),
  });
}

async function storedRows() {
  return await server.db
    .select()
    .from(vaultItems)
    .where(
      and(eq(vaultItems.tenant_id, server.tenantId), eq(vaultItems.connector_id, connectorId)),
    );
}

describe("signed JWT credential HTTP journey", () => {
  test("rejects an invalid key without storing credential material", async () => {
    const result = await attach("invalid-private-key-fixture");
    expect(result.status).toBe(400);
    expect(await result.text()).not.toContain("invalid-private-key-fixture");
    expect(await storedRows()).toHaveLength(0);
  });

  test("stores encrypted key, serves only a safe summary, and rotates atomically", async () => {
    const result = await attach(privateKey);
    expect(result.status).toBe(201);
    const response = await result.text();
    expect(response).not.toContain("PRIVATE KEY");
    const firstRows = await storedRows();
    expect(firstRows).toHaveLength(1);
    expect(JSON.stringify(firstRows)).not.toContain(privateKey);
    const resolved = await getCredentialForConnector(
      server.tenantId,
      connectorId,
      "dev",
      server.db,
    );
    expect(resolved?.value).toEqual({ mode: "signed_jwt", private_key: privateKey });
    const summary = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/credential`, {
      headers: { authorization: `Bearer ${server.apiKey}` },
    });
    expect(summary.status).toBe(200);
    expect(await summary.text()).not.toContain("PRIVATE KEY");
    const replacement = await exportPKCS8(
      (await generateKeyPair("ES256", { extractable: true })).privateKey,
    );
    expect((await attach(replacement)).status).toBe(201);
    const secondRows = await storedRows();
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0]?.id).toBe(firstRows[0]?.id);
    expect(secondRows[0]?.credential_generation).toBeGreaterThan(
      firstRows[0]?.credential_generation ?? 0,
    );
    expect(
      (await getCredentialForConnector(server.tenantId, connectorId, "dev", server.db))?.value,
    ).toEqual({ mode: "signed_jwt", private_key: replacement });
    expect((await attach("invalid-replacement")).status).toBe(400);
    expect(
      (await getCredentialForConnector(server.tenantId, connectorId, "dev", server.db))?.value,
    ).toEqual({ mode: "signed_jwt", private_key: replacement });
  });

  test("secure browser grant accepts a pasted PEM and cannot be replayed", async () => {
    const grant = generateCredentialSetupGrant();
    await server.db.insert(connectorCredentialSetupGrants).values({
      tenant_id: server.tenantId,
      connector_id: connectorId,
      token_sha256: grant.hash,
      created_by_actor_id: server.userId,
      expires_at: new Date(now() + 60_000),
    });
    const endpoint = `${server.baseUrl}/v1/connectors/${connectorId}/credentials/setup`;
    const page = await fetch(`${endpoint}?grant=${encodeURIComponent(grant.plaintext)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('name="private_key"');
    expect(html).toContain('type="password"');
    const request = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant: grant.plaintext,
        private_key: privateKey.replaceAll("\n", ""),
      }).toString(),
    };
    const saved = await fetch(endpoint, request);
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain("BEGIN PRIVATE KEY");
    expect((await fetch(endpoint, request)).status).toBe(400);
  });
});
