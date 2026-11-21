import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  deriveAppliedAuthMethod,
  resolveConnectorCredential,
} from "../../../connectors/drivers/http.ts";
import { getConnector } from "../../../connectors/service.ts";
import { auditLog, vaultItems } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { withSelfHostedDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { seedConnector, seedTenant } from "../../../test-helpers/seed.ts";
import { getCredentialForConnector, upsertCredential } from "../../service.ts";
import { refreshTokenMintIfStale, TOKEN_MINT_REFRESH_LEAD_MS } from "../refresh-worker.ts";

let ctx: TestDb;
type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let fetchSpy: ReturnType<typeof mock<FetchFn>>;
let minted = 0;

beforeAll(async () => {
  ctx = await createTestDb("token_mint_refresh");
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  minted = 0;
  fetchSpy = mock<FetchFn>(async () => {
    minted += 1;
    return new Response(JSON.stringify({ data: { token: `minted-${minted}`, expires_in: 3600 } }), {
      status: 200,
    });
  });
});

async function seedTokenMint(opts: { access_token: string; expires_at: Date | null }) {
  const tenant = await seedTenant(ctx.db);
  const connector = await seedConnector(ctx.db, {
    tenant_id: tenant.id,
    auth_type: "token_mint",
    base_url: "https://api.example.test",
  });
  await upsertCredential(
    {
      tenant_id: tenant.id,
      connector_id: connector.id,
      environment: "dev",
      mode: "token_mint",
      value: {
        mode: "token_mint",
        access_token: opts.access_token,
        shape: "json",
        mint_endpoint: "https://idp.example.test/login",
        credentials: { username: "mint-user", password: "mint-pass" },
        token_path: "data.token",
        expires_in_path: "data.expires_in",
      },
      oauth2_expires_at: opts.expires_at,
      actor_id: null,
    },
    ctx.db,
  );
  const view = await getConnector(tenant.id, connector.id, ctx.db);
  if (!view) throw new Error("connector missing");
  return { tenant_id: tenant.id, connector: view };
}

function resolve(
  tenant_id: string,
  connector: NonNullable<Awaited<ReturnType<typeof getConnector>>>,
) {
  return withSelfHostedDriverFetchForTests(fetchSpy as unknown as typeof fetch, () =>
    resolveConnectorCredential({ db: ctx.db, tenant_id, connector }),
  );
}

async function refreshAudits(tenant_id: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, "vault.item.refreshed")));
}

describe("token_mint refresh through the HTTP driver", () => {
  test("a credential without a minted token is minted, persisted, audited and reported as refreshed", async () => {
    const { tenant_id, connector } = await seedTokenMint({ access_token: "", expires_at: null });
    const before = await getCredentialForConnector(tenant_id, connector.id, "dev", ctx.db);

    const resolved = await resolve(tenant_id, connector);

    expect(minted).toBe(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      username: "mint-user",
      password: "mint-pass",
    });
    expect(resolved.credential?.mode).toBe("token_mint");
    if (resolved.credential?.mode !== "token_mint") throw new Error("wrong mode");
    expect(resolved.credential.access_token).toBe("minted-1");
    expect(resolved.oauth2_refreshed).toBe(true);
    expect(deriveAppliedAuthMethod(resolved.credential, resolved.oauth2_refreshed)).toBe(
      "token_mint_refreshed",
    );
    expect(resolved.credential_snapshot?.credential_generation).toBe(
      before!.row.credential_generation + 1,
    );

    const persisted = await getCredentialForConnector(tenant_id, connector.id, "dev", ctx.db);
    if (persisted?.value.mode !== "token_mint") throw new Error("wrong mode");
    expect(persisted.value.access_token).toBe("minted-1");
    expect(persisted.value.credentials).toEqual({ username: "mint-user", password: "mint-pass" });
    expect(persisted.row.oauth2_expires_at).toBeInstanceOf(Date);

    const audits = await refreshAudits(tenant_id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.result).toBe("success");
    expect(audits[0]!.metadata).toMatchObject({ connector_id: connector.id, mode: "token_mint" });
  });

  test("a fresh minted token is reused without a mint call and reported as static", async () => {
    const { tenant_id, connector } = await seedTokenMint({ access_token: "", expires_at: null });
    await resolve(tenant_id, connector);
    expect(minted).toBe(1);

    const second = await resolve(tenant_id, connector);

    expect(minted).toBe(1);
    if (second.credential?.mode !== "token_mint") throw new Error("wrong mode");
    expect(second.credential.access_token).toBe("minted-1");
    expect(second.oauth2_refreshed).toBe(false);
    expect(deriveAppliedAuthMethod(second.credential, second.oauth2_refreshed)).toBe(
      "token_mint_static",
    );
  });

  test("a minted token inside the refresh lead window is re-minted before it expires", async () => {
    const expiresSoon = new Date(Date.now() + TOKEN_MINT_REFRESH_LEAD_MS / 2); // allow-wall-clock: expiry must sit inside the real refresh lead window
    const { tenant_id, connector } = await seedTokenMint({
      access_token: "about-to-expire",
      expires_at: expiresSoon,
    });

    const resolved = await resolve(tenant_id, connector);

    expect(minted).toBe(1);
    if (resolved.credential?.mode !== "token_mint") throw new Error("wrong mode");
    expect(resolved.credential.access_token).toBe("minted-1");
    expect(resolved.credential.expires_at!.getTime()).toBeGreaterThan(expiresSoon.getTime());
    expect(deriveAppliedAuthMethod(resolved.credential, resolved.oauth2_refreshed)).toBe(
      "token_mint_refreshed",
    );
    const persisted = await getCredentialForConnector(tenant_id, connector.id, "dev", ctx.db);
    if (persisted?.value.mode !== "token_mint") throw new Error("wrong mode");
    expect(persisted.value.access_token).toBe("minted-1");
  });

  test("a rejected mint keeps the stored token, audits the error and reports static", async () => {
    fetchSpy.mockImplementation(async () => new Response("denied", { status: 401 }));
    const { tenant_id, connector } = await seedTokenMint({
      access_token: "stale",
      expires_at: null,
    });

    const resolved = await resolve(tenant_id, connector);

    if (resolved.credential?.mode !== "token_mint") throw new Error("wrong mode");
    expect(resolved.credential.access_token).toBe("stale");
    expect(resolved.oauth2_refreshed).toBe(false);
    expect(deriveAppliedAuthMethod(resolved.credential, resolved.oauth2_refreshed)).toBe(
      "token_mint_static",
    );
    const audits = await refreshAudits(tenant_id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.result).toBe("error");
    expect(audits[0]!.reason).toBe("credential_response_rejected: http_401");
  });

  test("a concurrent rotation surfaces credential_generation_changed instead of overwriting it", async () => {
    const { tenant_id, connector } = await seedTokenMint({ access_token: "", expires_at: null });
    const fetched = await getCredentialForConnector(tenant_id, connector.id, "dev", ctx.db);
    if (!fetched) throw new Error("credential missing");
    const { row, value } = fetched;
    if (value.mode !== "token_mint") throw new Error("wrong mode");
    await ctx.db
      .update(vaultItems)
      .set({ credential_generation: row.credential_generation + 5 })
      .where(and(eq(vaultItems.tenant_id, tenant_id), eq(vaultItems.id, row.id)));

    await expect(
      withSelfHostedDriverFetchForTests(fetchSpy as unknown as typeof fetch, () =>
        refreshTokenMintIfStale(ctx.db, tenant_id, row, value),
      ),
    ).rejects.toMatchObject({ code: "credential_generation_changed" });
  });

  test("a credential row from another tenant is refused", async () => {
    const { tenant_id, connector } = await seedTokenMint({ access_token: "", expires_at: null });
    const other = await seedTenant(ctx.db);
    const fetched = await getCredentialForConnector(tenant_id, connector.id, "dev", ctx.db);
    if (fetched?.value.mode !== "token_mint") throw new Error("wrong mode");

    await expect(
      refreshTokenMintIfStale(ctx.db, other.id, fetched.row, fetched.value),
    ).rejects.toThrow("credential_tenant_mismatch");
    expect(minted).toBe(0);
  });
});
