import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { exportPKCS8, generateKeyPair } from "jose";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getCredentialForConnector, upsertCredential } from "../service.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("credentials_svc_modes");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedTenantAndConnector(): Promise<{ tenant_id: string; connector_id: string }> {
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${Math.random().toString(36).slice(2, 8)}`, display_name: "T" }) // allow-random: test fixture
    .returning();
  const [conn] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenant!.id,
      slug: `c-${Math.random().toString(36).slice(2, 8)}`, // allow-random: test fixture
      display_name: "C",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://example.test",
    })
    .returning();
  return { tenant_id: tenant!.id, connector_id: conn!.id };
}

describe("credentials/service — mode round trips", () => {
  test("none: encrypts empty plaintext and decrypts back to {mode:none}", async () => {
    const { tenant_id, connector_id } = await seedTenantAndConnector();
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "none",
        value: { mode: "none" },
        actor_id: null,
      },
      ctx.db,
    );
    const fetched = await getCredentialForConnector(tenant_id, connector_id, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    expect(fetched!.value.mode).toBe("none");
  });

  test("header: round trips the header map", async () => {
    const { tenant_id, connector_id } = await seedTenantAndConnector();
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "header",
        value: { mode: "header", headers: { "x-api-key": "secret-header-value" } },
        actor_id: null,
      },
      ctx.db,
    );
    const fetched = await getCredentialForConnector(tenant_id, connector_id, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    expect(fetched!.value.mode).toBe("header");
    if (fetched!.value.mode === "header") {
      expect(fetched!.value.headers["x-api-key"]).toBe("secret-header-value");
    }
  });

  test("query: round trips the query map", async () => {
    const { tenant_id, connector_id } = await seedTenantAndConnector();
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "query",
        value: { mode: "query", query: { api_key: "qk-secret" } },
        actor_id: null,
      },
      ctx.db,
    );
    const fetched = await getCredentialForConnector(tenant_id, connector_id, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    expect(fetched!.value.mode).toBe("query");
    if (fetched!.value.mode === "query") {
      expect(fetched!.value.query.api_key).toBe("qk-secret");
    }
  });

  test("basic: round trips username + password", async () => {
    const { tenant_id, connector_id } = await seedTenantAndConnector();
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "basic",
        value: { mode: "basic", username: "svc-user", password: "hunter2" },
        actor_id: null,
      },
      ctx.db,
    );
    const fetched = await getCredentialForConnector(tenant_id, connector_id, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    expect(fetched!.value.mode).toBe("basic");
    if (fetched!.value.mode === "basic") {
      expect(fetched!.value.username).toBe("svc-user");
      expect(fetched!.value.password).toBe("hunter2");
    }
  });

  test("aws_sigv4: round trips identity material including the optional session token", async () => {
    const { tenant_id, connector_id } = await seedTenantAndConnector();
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "aws_sigv4",
        value: {
          mode: "aws_sigv4",
          access_key_id: "AKIAEXAMPLE",
          secret_access_key: "secret-key-value",
          session_token: "session-token-value",
        },
        actor_id: null,
      },
      ctx.db,
    );
    const fetched = await getCredentialForConnector(tenant_id, connector_id, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    expect(fetched!.value.mode).toBe("aws_sigv4");
    if (fetched!.value.mode === "aws_sigv4") {
      expect(fetched!.value.access_key_id).toBe("AKIAEXAMPLE");
      expect(fetched!.value.secret_access_key).toBe("secret-key-value");
      expect(fetched!.value.session_token).toBe("session-token-value");
    }
  });

  test("aws_sigv4: round trips without the optional session token", async () => {
    const { tenant_id, connector_id } = await seedTenantAndConnector();
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "aws_sigv4",
        value: {
          mode: "aws_sigv4",
          access_key_id: "AKIASTATIC",
          secret_access_key: "static-secret",
        },
        actor_id: null,
      },
      ctx.db,
    );
    const fetched = await getCredentialForConnector(tenant_id, connector_id, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    if (fetched!.value.mode === "aws_sigv4") {
      expect(fetched!.value.session_token).toBeUndefined();
    }
  });

  test("token_mint: round trips the full shape including every optional path field", async () => {
    const { tenant_id, connector_id } = await seedTenantAndConnector();
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "token_mint",
        value: {
          mode: "token_mint",
          access_token: "cached-access-token",
          shape: "aws_initiate_auth",
          mint_endpoint: "https://cognito-idp.eu-central-1.amazonaws.com/",
          credentials: { username: "mint-user", password: "mint-pass" },
          token_path: "AuthenticationResult.IdToken",
          refresh_token_path: "AuthenticationResult.RefreshToken",
          expires_in_path: "AuthenticationResult.ExpiresIn",
          expires_at_path: "AuthenticationResult.ExpiresAt",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: header_template is a literal placeholder string, not a JS template
          header_template: "Bearer ${token}",
        },
        actor_id: null,
      },
      ctx.db,
    );
    const fetched = await getCredentialForConnector(tenant_id, connector_id, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    expect(fetched!.value.mode).toBe("token_mint");
    if (fetched!.value.mode === "token_mint") {
      expect(fetched!.value.access_token).toBe("cached-access-token");
      expect(fetched!.value.shape).toBe("aws_initiate_auth");
      expect(fetched!.value.mint_endpoint).toBe("https://cognito-idp.eu-central-1.amazonaws.com/");
      expect(fetched!.value.credentials.username).toBe("mint-user");
      expect(fetched!.value.token_path).toBe("AuthenticationResult.IdToken");
      expect(fetched!.value.refresh_token_path).toBe("AuthenticationResult.RefreshToken");
      expect(fetched!.value.expires_in_path).toBe("AuthenticationResult.ExpiresIn");
      expect(fetched!.value.expires_at_path).toBe("AuthenticationResult.ExpiresAt");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: header_template is a literal placeholder string, not a JS template
      expect(fetched!.value.header_template).toBe("Bearer ${token}");
    }
  });

  test("token_mint: round trips the minimal shape without the optional path fields", async () => {
    const { tenant_id, connector_id } = await seedTenantAndConnector();
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "token_mint",
        value: {
          mode: "token_mint",
          access_token: "",
          shape: "json",
          mint_endpoint: "https://idp.example.test/login",
          credentials: { username: "u", password: "p" },
          token_path: "access_token",
        },
        actor_id: null,
      },
      ctx.db,
    );
    const fetched = await getCredentialForConnector(tenant_id, connector_id, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    if (fetched!.value.mode === "token_mint") {
      expect(fetched!.value.refresh_token_path).toBeUndefined();
      expect(fetched!.value.expires_in_path).toBeUndefined();
      expect(fetched!.value.expires_at_path).toBeUndefined();
      expect(fetched!.value.header_template).toBeUndefined();
    }
  });

  test("signed_jwt: validates and encrypts a PKCS#8 private key", async () => {
    const { tenant_id, connector_id } = await seedTenantAndConnector();
    const pair = await generateKeyPair("ES256", { extractable: true });
    const private_key = await exportPKCS8(pair.privateKey);
    await ctx.db
      .update(connectors)
      .set({
        auth_type: "signed_jwt",
        config: { signed_jwt: { algorithm: "ES256", audience: "provider-api" } },
      })
      .where(eq(connectors.id, connector_id));
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "signed_jwt",
        value: { mode: "signed_jwt", private_key },
        actor_id: null,
      },
      ctx.db,
    );
    const fetched = await getCredentialForConnector(tenant_id, connector_id, "dev", ctx.db);
    expect(fetched?.value).toEqual({ mode: "signed_jwt", private_key });
  });
});
