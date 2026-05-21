// waitForOAuthCredential — integration tests.
//
// The wait bridges the gap between handing the operator an authorization
// URL and the out-of-band OAuth callback landing a `credentials` row.
// It resolves on three signals: a `callback_succeeded` event (re-verified
// by a credential re-read), a `credentials`-row poll, an explicit
// `callback_failed` event, or a timeout.
//
// These tests boot the real pub/sub listener against a disposable
// Postgres so `getListener()` resolves, then drive the GLOBAL emitter
// directly — no NOTIFY round-trip, fully deterministic. The credential
// row content is irrelevant to the wait (it only checks existence), so
// rows are inserted with placeholder ciphertext bytes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, credentials, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { globalEmitter } from "../../../pubsub/emitter.ts";
import { startListener, stopListener } from "../../../pubsub/listener.ts";
import type { EventEnvelope } from "../../../pubsub/types.ts";
import { waitFor } from "../../../test-helpers/determinism/wait.ts";
import { waitForOAuthCredential } from "../wait.ts";

let ctx: TestDb;
let tenant_id: string;
let connector_id: string;
let otherConnectorId: string;

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

  // Boot the listener so `getListener()` resolves inside waitForOAuthCredential.
  // Subscribe only to `connector.oauth` to keep the boot lean.
  await startListener({
    connectionString: ctx.url,
    db: ctx.db,
    channels: ["connector.oauth"],
    listenerId: "oauth-wait-test",
  });
});

afterAll(async () => {
  await stopListener();
  await ctx.cleanup();
});

/** Insert a non-deleted credential row (existence is all the wait checks). */
async function insertCredential(connectorId: string): Promise<string> {
  const [row] = await ctx.db
    .insert(credentials)
    .values({
      tenant_id,
      connector_id: connectorId,
      environment: "dev",
      mode: "oauth2",
      ciphertext: PLACEHOLDER,
      iv: PLACEHOLDER,
      auth_tag: PLACEHOLDER,
    })
    .returning({ id: credentials.id });
  return row!.id;
}

/** Soft-delete a credential row (sets deleted_at) without freeing the
 *  `(connector_id, environment, mode)` unique slot. */
async function softDeleteCredential(id: string): Promise<void> {
  const { eq } = await import("drizzle-orm");
  await ctx.db
    .update(credentials)
    .set({ deleted_at: new Date() }) // allow-wall-clock: deleted_at marker, value irrelevant
    .where(eq(credentials.id, id));
}

/** Hard-delete a credential row so the unique slot is free for re-insert
 *  by the next test. The `(connector_id, environment, mode)` constraint
 *  treats a soft-deleted row as still occupying the slot. */
async function hardDeleteCredential(id: string): Promise<void> {
  const { eq } = await import("drizzle-orm");
  await ctx.db.delete(credentials).where(eq(credentials.id, id));
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
    payload: { connector_id: connectorId, reason },
    created_at: new Date(), // allow-wall-clock: synthetic event envelope timestamp
  };
}

/**
 * `waitForOAuthCredential` runs an async `credentialExists` idempotency
 * query BEFORE it registers its pubsub handler. A test that dispatches
 * an event the instant the wait is called would race that registration.
 * Poll the emitter's subscriber count so the dispatch is observed.
 */
async function awaitHandlerRegistered(beforeCount: number): Promise<void> {
  // The idempotency check is a real Postgres round-trip — poll with a
  // short real sleep (allow-wall-clock: I/O-bound) rather than a
  // microtask flush, which would out-run the query.
  await waitFor(() => globalEmitter.listenerCount("connector.oauth") > beforeCount, {
    label: "oauth.wait handler registration",
    sleepMs: 5,
    tries: 200,
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
    });
    expect(status).toBe("succeeded");
    await hardDeleteCredential(credId);
  });

  test("succeeded via the callback_succeeded event (credential row re-read)", async () => {
    const before = globalEmitter.listenerCount("connector.oauth");
    // No credential yet — start the wait, then land the row + fire the event.
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: 5_000,
      db: ctx.db,
    });
    await awaitHandlerRegistered(before);
    // The handler re-reads the credential row before concluding succeeded;
    // insert the row first so the re-read passes.
    const credId = await insertCredential(connector_id);
    await globalEmitter.dispatch(succeededEvent(connector_id));
    const status = await waiting;
    expect(status).toBe("succeeded");
    await hardDeleteCredential(credId);
  });

  test("succeeded via the DB poll when no event arrives", async () => {
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      // poll interval is 1.5s; allow two ticks before the timeout bound.
      timeout_ms: 5_000,
      db: ctx.db,
    });
    const credId = await insertCredential(connector_id);
    const status = await waiting;
    expect(status).toBe("succeeded");
    await hardDeleteCredential(credId);
  });

  test("a callback_succeeded event WITHOUT a credential row does not resolve succeeded", async () => {
    // The handler re-reads the credential row; if it is absent the event
    // is ignored and only the timeout settles the wait.
    const before = globalEmitter.listenerCount("connector.oauth");
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: 800,
      db: ctx.db,
    });
    await awaitHandlerRegistered(before);
    // Fire the event mid-wait — but no credential row was inserted, so
    // the handler's credential re-read fails and the event is dropped.
    await globalEmitter.dispatch(succeededEvent(connector_id));
    const status = await waiting;
    expect(status).toBe("timeout");
  });

  test("failed ONLY via an explicit callback_failed event", async () => {
    const before = globalEmitter.listenerCount("connector.oauth");
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: 5_000,
      db: ctx.db,
    });
    await awaitHandlerRegistered(before);
    await globalEmitter.dispatch(failedEvent(connector_id));
    const status = await waiting;
    expect(status).toBe("failed");
  });

  test("timeout when no signal fires within the bound", async () => {
    const status = await waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: 400,
      db: ctx.db,
    });
    expect(status).toBe("timeout");
  });

  test("ignores a callback_succeeded event for a DIFFERENT connector", async () => {
    const before = globalEmitter.listenerCount("connector.oauth");
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: 700,
      db: ctx.db,
    });
    await awaitHandlerRegistered(before);
    // Land a credential for the OTHER connector + fire its event — the
    // wait keyed on `connector_id` must not resolve on it.
    const credId = await insertCredential(otherConnectorId);
    await globalEmitter.dispatch(succeededEvent(otherConnectorId));
    const status = await waiting;
    expect(status).toBe("timeout");
    await hardDeleteCredential(credId);
  });

  test("ignores a callback_failed event for a DIFFERENT connector", async () => {
    const before = globalEmitter.listenerCount("connector.oauth");
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: 700,
      db: ctx.db,
    });
    await awaitHandlerRegistered(before);
    await globalEmitter.dispatch(failedEvent(otherConnectorId));
    const status = await waiting;
    expect(status).toBe("timeout");
  });

  test("credentialExists filtering ignores a soft-deleted credential row", async () => {
    // A credential exists but is soft-deleted — the wait must NOT treat
    // it as a landed credential (deleted_at IS NULL filter).
    const credId = await insertCredential(connector_id);
    await softDeleteCredential(credId);
    const status = await waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: 400,
      db: ctx.db,
    });
    expect(status).toBe("timeout");
    await hardDeleteCredential(credId);
  });

  test("a callback_succeeded event for the wrong tenant is ignored", async () => {
    const before = globalEmitter.listenerCount("connector.oauth");
    // Timeout generously above the 1.5s poll interval — the cross-tenant
    // event is dropped, so only the DB poll can settle this `succeeded`.
    const waiting = waitForOAuthCredential({
      tenant_id,
      connector_id,
      environment: "dev",
      timeout_ms: 6_000,
      db: ctx.db,
    });
    await awaitHandlerRegistered(before);
    const credId = await insertCredential(connector_id);
    await globalEmitter.dispatch({
      ...succeededEvent(connector_id),
      tenant_id: "00000000-0000-0000-0000-000000000000",
    });
    const status = await waiting;
    // The cross-tenant event is dropped; only the DB poll (same tenant)
    // eventually settles it succeeded.
    expect(status).toBe("succeeded");
    await hardDeleteCredential(credId);
  });
});
