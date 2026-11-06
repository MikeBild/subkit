import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { serializeConnector } from "../../../api/operations/connector-template-representation.ts";
import {
  CONNECTOR_SECRET_MASK,
  getConnector,
  resolveConnectorOAuthConfig,
} from "../../../connectors/index.ts";
import { auditLog, connectors } from "../../../db/schema/index.ts";
import { FROZEN_NOW } from "../../../test-helpers/determinism/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

const CLIENT_SECRET = "fixture-client-secret-not-real";
const HEADER_SECRET = "fixture-header-secret-not-real";
const DSN_SECRET = "fixture-dsn-secret-not-real";
const SECRETS = [CLIENT_SECRET, HEADER_SECRET, DSN_SECRET];

type Json = Record<string, unknown>;

let ctx: HttpTestServer;
let oauthConnectorId: string;
let postgresConnectorId: string;

function auth(): Record<string, string> {
  return { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: auth(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function expectNoSecret(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

function oauthDefinition(): Json {
  return {
    name: "Acme OAuth",
    slug: "acme-oauth",
    driver: "http",
    environment: "prod",
    base_url: "https://api.acme.test/v2",
    auth_type: "oauth2",
    config: {
      timeout_ms: 5000,
      static_headers: { Accept: "application/json", "X-Api-Key": HEADER_SECRET },
      oauth: {
        issuer_url: "https://login.acme.test",
        authorization_endpoint: "https://login.acme.test/authorize",
        token_endpoint: "https://login.acme.test/token",
        scope: "read:things",
        client_id: "acme-client-id",
        client_secret: CLIENT_SECRET,
      },
    },
  };
}

async function storedOAuthSecret(): Promise<string | undefined> {
  const view = await getConnector(ctx.tenantId, oauthConnectorId, ctx.db);
  if (!view) throw new Error("connector vanished");
  const cfg = await resolveConnectorOAuthConfig(ctx.db, ctx.tenantId, view);
  return cfg?.client_secret;
}

async function storedDsn(): Promise<string | null | undefined> {
  const [row] = await ctx.db
    .select({ dsn: connectors.dsn })
    .from(connectors)
    .where(eq(connectors.id, postgresConnectorId));
  return row?.dsn;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("connector-secret-masking");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("a connector representation carries no secret", () => {
  test("POST /v1/connectors answers with the mask, and stores the secret", async () => {
    const res = await send("POST", "/v1/connectors", oauthDefinition());
    expect(res.status).toBe(201);
    const text = await res.text();
    expectNoSecret(text);
    const body = JSON.parse(text) as { id: string; config: { oauth: Json; static_headers: Json } };
    oauthConnectorId = body.id;
    expect(body.config.oauth.client_secret).toBe(CONNECTOR_SECRET_MASK);
    expect(body.config.static_headers["X-Api-Key"]).toBe(CONNECTOR_SECRET_MASK);
    expect(await storedOAuthSecret()).toBe(CLIENT_SECRET);

    const pg = await send("POST", "/v1/connectors", {
      name: "Acme DB",
      slug: "acme-db",
      driver: "postgres",
      environment: "prod",
      dsn: `postgres://app_user:${DSN_SECRET}@db.acme.test:5432/app`,
    });
    expect(pg.status).toBe(201);
    const pgText = await pg.text();
    expectNoSecret(pgText);
    postgresConnectorId = (JSON.parse(pgText) as { id: string }).id;
  });

  test("GET /v1/connectors/{id} masks the secret and leaves the config around it readable", async () => {
    const res = await send("GET", `/v1/connectors/${oauthConnectorId}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expectNoSecret(text);
    const body = JSON.parse(text) as { config: { oauth: Json; static_headers: Json } & Json };
    expect(body.config.oauth).toEqual({
      issuer_url: "https://login.acme.test",
      authorization_endpoint: "https://login.acme.test/authorize",
      token_endpoint: "https://login.acme.test/token",
      scope: "read:things",
      client_id: "acme-client-id",
      client_secret: CONNECTOR_SECRET_MASK,
    });
    expect(body.config.static_headers.Accept).toBe("application/json");
    expect(body.config.timeout_ms).toBe(5000);
  });

  test("GET /v1/connectors/{id} masks only the password inside a dsn", async () => {
    const res = await send("GET", `/v1/connectors/${postgresConnectorId}`);
    const text = await res.text();
    expectNoSecret(text);
    expect((JSON.parse(text) as { dsn: string }).dsn).toBe(
      `postgres://app_user:${CONNECTOR_SECRET_MASK}@db.acme.test:5432/app`,
    );
  });

  test("GET /v1/connectors lists both without a secret", async () => {
    const res = await send("GET", "/v1/connectors");
    expect(res.status).toBe(200);
    const text = await res.text();
    expectNoSecret(text);
    const ids = (JSON.parse(text) as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(ids).toContain(oauthConnectorId);
    expect(ids).toContain(postgresConnectorId);
  });

  test("the enable and disable responses carry no secret either", async () => {
    for (const action of ["disable", "enable"]) {
      for (const id of [oauthConnectorId, postgresConnectorId]) {
        const res = await send("POST", `/v1/connectors/${id}/${action}`);
        expect(res.status).toBe(200);
        expectNoSecret(await res.text());
      }
    }
  });

  test("the from-template serializer goes through the same projection", async () => {
    const oauth = await getConnector(ctx.tenantId, oauthConnectorId, ctx.db);
    const pg = await getConnector(ctx.tenantId, postgresConnectorId, ctx.db);
    if (!oauth || !pg) throw new Error("connector vanished");
    expectNoSecret(JSON.stringify([serializeConnector(oauth), serializeConnector(pg)]));
  });
});

describe("a representation written back keeps the stored secret", () => {
  test("GET then PATCH of the returned config — the `get` → `patch --file` round trip", async () => {
    const read = (await (await send("GET", `/v1/connectors/${oauthConnectorId}`)).json()) as {
      config: Json;
    };
    const res = await send("PATCH", `/v1/connectors/${oauthConnectorId}`, {
      config: { ...read.config, timeout_ms: 9000 },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expectNoSecret(text);
    expect((JSON.parse(text) as { config: Json }).config.timeout_ms).toBe(9000);

    expect(await storedOAuthSecret()).toBe(CLIENT_SECRET);
    const [row] = await ctx.db
      .select({ config: connectors.config })
      .from(connectors)
      .where(eq(connectors.id, oauthConnectorId));
    const stored = row?.config as { static_headers: Json; timeout_ms: number };
    expect(stored.static_headers["X-Api-Key"]).toBe(HEADER_SECRET);
    expect(stored.timeout_ms).toBe(9000);
  });

  test("the masked dsn written back as read keeps the password", async () => {
    const read = (await (await send("GET", `/v1/connectors/${postgresConnectorId}`)).json()) as {
      dsn: string;
    };
    const res = await send("PATCH", `/v1/connectors/${postgresConnectorId}`, { dsn: read.dsn });
    expect(res.status).toBe(200);
    expect(await storedDsn()).toBe(`postgres://app_user:${DSN_SECRET}@db.acme.test:5432/app`);
  });
});

describe("a kept secret does not follow a changed destination", () => {
  test("a masked dsn on another host is refused and the stored dsn is untouched", async () => {
    const res = await send("PATCH", `/v1/connectors/${postgresConnectorId}`, {
      dsn: `postgres://app_user:${CONNECTOR_SECRET_MASK}@other-host.acme.test:5432/app`,
    });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain("send the real value");
    expectNoSecret(text);
    expect(await storedDsn()).toBe(`postgres://app_user:${DSN_SECRET}@db.acme.test:5432/app`);
  });

  test("the real password moves the dsn to another host", async () => {
    const dsn = `postgres://app_user:${DSN_SECRET}@replica.acme.test:5432/app`;
    const res = await send("PATCH", `/v1/connectors/${postgresConnectorId}`, { dsn });
    expect(res.status).toBe(200);
    expectNoSecret(await res.text());
    expect(await storedDsn()).toBe(dsn);
  });

  test("a masked client secret with another token endpoint is refused", async () => {
    const before = await storedOAuthSecret();
    const read = (await (await send("GET", `/v1/connectors/${oauthConnectorId}`)).json()) as {
      config: { oauth: Json } & Json;
    };
    const res = await send("PATCH", `/v1/connectors/${oauthConnectorId}`, {
      config: {
        ...read.config,
        oauth: { ...read.config.oauth, token_endpoint: "https://login.elsewhere.test/token" },
      },
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("config.oauth.token_endpoint changed");
    expect(await storedOAuthSecret()).toBe(before);
    const view = await getConnector(ctx.tenantId, oauthConnectorId, ctx.db);
    expect(view?.config.oauth).toMatchObject({ token_endpoint: "https://login.acme.test/token" });
  });

  test("a masked static header with another base_url is refused", async () => {
    const read = (await (await send("GET", `/v1/connectors/${oauthConnectorId}`)).json()) as {
      config: Json;
    };
    const res = await send("PATCH", `/v1/connectors/${oauthConnectorId}`, {
      base_url: "https://api.elsewhere.test/v2",
      config: read.config,
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("base_url changed");
    const view = await getConnector(ctx.tenantId, oauthConnectorId, ctx.db);
    expect(view?.base_url).toBe("https://api.acme.test/v2");
  });

  test("re-posting a read definition under its own slug with another base_url is refused", async () => {
    const read = (await (await send("GET", `/v1/connectors/${oauthConnectorId}`)).json()) as {
      config: Json;
    };
    const res = await send("POST", "/v1/connectors", {
      ...oauthDefinition(),
      base_url: "https://api.elsewhere.test/v2",
      config: read.config,
    });
    expect(res.status).toBe(422);
    const view = await getConnector(ctx.tenantId, oauthConnectorId, ctx.db);
    expect(view?.base_url).toBe("https://api.acme.test/v2");
  });

  test("a value that only contains the mask is refused, never stored", async () => {
    const res = await send("PATCH", `/v1/connectors/${oauthConnectorId}`, {
      config: { static_headers: { Authorization: `Bearer ${CONNECTOR_SECRET_MASK}` } },
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("config.static_headers.Authorization");
  });
});

describe("a representation written back keeps the stored secret, or takes a new one", () => {
  test("a real value in place of the mask rotates the secret", async () => {
    const read = (await (await send("GET", `/v1/connectors/${oauthConnectorId}`)).json()) as {
      config: { oauth: Json } & Json;
    };
    const rotated = "fixture-rotated-secret-not-real";
    const res = await send("PATCH", `/v1/connectors/${oauthConnectorId}`, {
      config: { ...read.config, oauth: { ...read.config.oauth, client_secret: rotated } },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(rotated);
    expect(await storedOAuthSecret()).toBe(rotated);
  });

  test("re-posting a read definition under its own slug keeps the secret", async () => {
    const before = await storedOAuthSecret();
    const read = (await (await send("GET", `/v1/connectors/${oauthConnectorId}`)).json()) as {
      config: Json;
    };
    const res = await send("POST", "/v1/connectors", { ...oauthDefinition(), config: read.config });
    expect(res.status).toBe(201);
    expect(await storedOAuthSecret()).toBe(before);
  });

  test("the mask on a connector that has nothing stored is refused, not saved", async () => {
    const created = await send("POST", "/v1/connectors", {
      ...oauthDefinition(),
      slug: "acme-copy",
      config: { oauth: { client_id: "acme-client-id", client_secret: CONNECTOR_SECRET_MASK } },
    });
    expect(created.status).toBe(422);
    expect(await created.text()).toContain("config.oauth.client_secret");

    const patched = await send("PATCH", `/v1/connectors/${postgresConnectorId}`, {
      config: { oauth: { client_secret: CONNECTOR_SECRET_MASK } },
    });
    expect(patched.status).toBe(422);

    const rows = await ctx.db.select().from(connectors).where(eq(connectors.slug, "acme-copy"));
    expect(rows).toHaveLength(0);
  });
});

describe("the audit trail of those writes", () => {
  test("records before and after without the secret or the dsn password", async () => {
    const rows = await ctx.db
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(eq(auditLog.action, "connector.updated"));
    const text = JSON.stringify(rows);
    expect(text).toContain("replica.acme.test");
    expect(text).toContain("acme-client-id");
    expectNoSecret(text);
  });
});

describe("the breaker is readable", () => {
  test("a closed breaker reports its state, no opening time and a zero count", async () => {
    const body = (await (await send("GET", `/v1/connectors/${oauthConnectorId}`)).json()) as Json;
    expect(body.circuit_state).toBe("closed");
    expect(body.circuit_opened_at).toBeNull();
    expect(body.circuit_failure_count).toBe(0);
  });

  test("an open breaker reports when it opened and how many failures it counted, on get and list", async () => {
    const openedAt = new Date(FROZEN_NOW);
    await ctx.db
      .update(connectors)
      .set({ circuit_state: "open", circuit_opened_at: openedAt, circuit_failure_count: 5 })
      .where(eq(connectors.id, oauthConnectorId));

    const expected = {
      circuit_state: "open",
      circuit_opened_at: openedAt.toISOString(),
      circuit_failure_count: 5,
    };
    const single = (await (await send("GET", `/v1/connectors/${oauthConnectorId}`)).json()) as Json;
    expect(single).toMatchObject(expected);
    const list = (await (await send("GET", "/v1/connectors")).json()) as { items: Json[] };
    expect(list.items.find((i) => i.id === oauthConnectorId)).toMatchObject(expected);
  });
});
