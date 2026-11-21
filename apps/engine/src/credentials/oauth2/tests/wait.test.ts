import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { connectors, tenants, vaultItems } from "../../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../../db/tests/setup.ts";
import { PubSubEmitter } from "../../../pubsub/emitter.ts";
import { PubSubListener } from "../../../pubsub/listener.ts";
import type { EventEnvelope } from "../../../pubsub/types.ts";
import { waitFor } from "../../../test-helpers/determinism/wait.ts";
import { OAUTH_WAIT_MIN_FLOOR_MS, POLL_INTERVAL_MS, waitForOAuthCredential } from "../wait.ts";

setDefaultTimeout(TEST_DB_HOOK_TIMEOUT);

const EVENT_BUDGET_MS = OAUTH_WAIT_MIN_FLOOR_MS;
const POLL_BUDGET_MS = POLL_INTERVAL_MS * 4;
const SHORT_TIMEOUT_MS = POLL_INTERVAL_MS + POLL_INTERVAL_MS / 2;

let ctx: TestDb;
let tenant_id: string;
let connector_id: string;
let otherConnectorId: string;
let emitter: PubSubEmitter;
let listener: PubSubListener;

const PLACEHOLDER = Buffer.from([0x01]);

beforeAll(async () => {
  ctx = await createTestDb("oauth_wait");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-oauth-wait", display_name: "OAuth Wait" })
    .returning();
  tenant_id = t!.id;
  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "oauth-conn",
      display_name: "OAuth Connector",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://example.test",
      config: {},
    })
    .returning();
  connector_id = c!.id;
  const [c2] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "oauth-conn-other",
      display_name: "Other Connector",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://example.test",
      config: {},
    })
    .returning();
  otherConnectorId = c2!.id;

  emitter = new PubSubEmitter();
  listener = new PubSubListener({
    connectionString: ctx.url,
    db: ctx.db,
    channels: ["connector.oauth"],
    listenerId: "oauth-wait-test",
    emitter,
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

async function insertCredential(connectorId: string): Promise<string> {
  const [row] = await ctx.db
    .insert(vaultItems)
    .values({
      tenant_id,
      connector_id: connectorId,
      environment: "dev",
      mode: "oauth2",
      ciphertext: PLACEHOLDER,
      iv: PLACEHOLDER,
      auth_tag: PLACEHOLDER,
    })
    .returning({ id: vaultItems.id });
  return row!.id;
}

async function softDeleteCredential(id: string): Promise<void> {
  const { eq } = await import("drizzle-orm");
  await ctx.db
    .update(vaultItems)
    .set({ deleted_at: new Date() }) // allow-wall-clock: deleted_at marker, value irrelevant
    .where(eq(vaultItems.id, id));
}

async function hardDeleteCredential(id: string): Promise<void> {
  const { eq } = await import("drizzle-orm");
  await ctx.db.delete(vaultItems).where(eq(vaultItems.id, id));
}

function succeededEvent(connectorId: string): EventEnvelope {
  return {
    id: 1,
    tenant_id,
    channel: "connector.oauth",
    type: "connector.oauth.callback_succeeded",
    payload: {
      connector_id: connectorId,
      connector_slug: "oauth-conn",
      has_refresh_token: true,
      source: "oauth_callback",
    },
    created_at: new Date(), // allow-wall-clock: synthetic event envelope timestamp
  };
}

function failedEvent(connectorId: string, reason = "provider_error"): EventEnvelope {
  return {
    id: 2,
    tenant_id,
    channel: "connector.oauth",
    type: "connector.oauth.callback_failed",
    payload: { connector_id: connectorId, connector_slug: "oauth-conn", reason },
    created_at: new Date(), // allow-wall-clock: synthetic event envelope timestamp
  };
}

async function awaitHandlerRegistered(beforeCount: number): Promise<void> {
  // short real sleep (allow-wall-clock: I/O-bound) rather than a
  // microtask flush, which would out-run the query.
  await waitFor(() => emitter.listenerCount("connector.oauth") > beforeCount, {
    label: "oauth.wait handler registration",
    sleepMs: 5,
    tries: 800,
  });
}

describe("waitForOAuthCredential", () => {
  test("idempotent — returns succeeded immediately when the credential already exists", async () => {
    const credId = await insertCredential(connector_id);
    const status = await waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: 500,
      db: ctx.db,
      listener,
    });
    expect(status).toBe("succeeded");
    await hardDeleteCredential(credId);
  });

  test("succeeded via the callback_succeeded event (credential row re-read)", async () => {
    const before = emitter.listenerCount("connector.oauth");
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: EVENT_BUDGET_MS,
      db: ctx.db,
      listener,
    });
    await awaitHandlerRegistered(before);
    const credId = await insertCredential(connector_id);
    await emitter.dispatch(succeededEvent(connector_id));
    const status = await waiting;
    expect(status).toBe("succeeded");
    await hardDeleteCredential(credId);
  });

  test("succeeded via the DB poll when no event arrives", async () => {
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: POLL_BUDGET_MS,
      db: ctx.db,
      listener,
    });
    const credId = await insertCredential(connector_id);
    const status = await waiting;
    expect(status).toBe("succeeded");
    await hardDeleteCredential(credId);
  });

  test("a callback_succeeded event WITHOUT a credential row does not resolve succeeded", async () => {
    const before = emitter.listenerCount("connector.oauth");
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: SHORT_TIMEOUT_MS,
      db: ctx.db,
      listener,
    });
    await awaitHandlerRegistered(before);
    await emitter.dispatch(succeededEvent(connector_id));
    const status = await waiting;
    expect(status).toBe("timeout");
  });

  test("failed ONLY via an explicit callback_failed event", async () => {
    const before = emitter.listenerCount("connector.oauth");
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: EVENT_BUDGET_MS,
      db: ctx.db,
      listener,
    });
    await awaitHandlerRegistered(before);
    await emitter.dispatch(failedEvent(connector_id));
    const status = await waiting;
    expect(status).toBe("failed");
  });

  test("timeout when no signal fires within the bound", async () => {
    const status = await waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: SHORT_TIMEOUT_MS,
      db: ctx.db,
      listener,
    });
    expect(status).toBe("timeout");
  });

  test("ignores a callback_succeeded event for a DIFFERENT connector", async () => {
    const before = emitter.listenerCount("connector.oauth");
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: SHORT_TIMEOUT_MS,
      db: ctx.db,
      listener,
    });
    await awaitHandlerRegistered(before);
    const credId = await insertCredential(otherConnectorId);
    await emitter.dispatch(succeededEvent(otherConnectorId));
    const status = await waiting;
    expect(status).toBe("timeout");
    await hardDeleteCredential(credId);
  });

  test("ignores a callback_failed event for a DIFFERENT connector", async () => {
    const before = emitter.listenerCount("connector.oauth");
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: SHORT_TIMEOUT_MS,
      db: ctx.db,
      listener,
    });
    await awaitHandlerRegistered(before);
    await emitter.dispatch(failedEvent(otherConnectorId));
    const status = await waiting;
    expect(status).toBe("timeout");
  });

  test("credentialExists filtering ignores a soft-deleted credential row", async () => {
    const credId = await insertCredential(connector_id);
    await softDeleteCredential(credId);
    const status = await waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: SHORT_TIMEOUT_MS,
      db: ctx.db,
      listener,
    });
    expect(status).toBe("timeout");
    await hardDeleteCredential(credId);
  });

  test("a callback_succeeded event for the wrong tenant is ignored", async () => {
    const before = emitter.listenerCount("connector.oauth");
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: POLL_BUDGET_MS,
      db: ctx.db,
      listener,
    });
    await awaitHandlerRegistered(before);
    const credId = await insertCredential(connector_id);
    await emitter.dispatch({
      ...succeededEvent(connector_id),
      tenant_id: "00000000-0000-0000-0000-000000000000",
    });
    const status = await waiting;
    expect(status).toBe("succeeded");
    await hardDeleteCredential(credId);
  });
});
