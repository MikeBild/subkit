// Integration tests for the global OAuth2 callback route.
//
// Covers the v4.7.3 refactor: a single unauthenticated
// `GET /v1/oauth/callback` looks up the connector by opaque `state`
// (atomically claimed via DELETE … RETURNING), exchanges the code at
// the OAuth provider, and persists the credential under the state
// row's tenant_id / connector_id. State encodes everything the
// callback needs; the callback URL is connector-agnostic.
//
// What the tests pin:
//   1. happy path — valid state + code → credential row written,
//      state row deleted, HTML success page returned.
//   2. provider error — `?error=access_denied` returns HTML error
//      page (200/400 with text/html, not JSON), state row deleted.
//   3. state replay — second GET with the same state returns the
//      "state not found" page (the first call atomically claimed
//      the row).
//   4. unknown state — random state value returns the same
//      not-found page (no leakage of valid-state-but-wrong-tenant).
//   5. the stored credential IS the re-authorization — the sign-in flag
//      and the circuit breaker are reset (each with its audit row), and a
//      switched-off connector stays switched off and is said to be.
//   6. where the person goes next follows where the flow was started: a
//      Cockpit flow is redirected to the connector's page — an address
//      built by the engine, whatever the callback's query says — and
//      every other flow, and every failure, gets a page worded for its
//      origin.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../../auth/browser-session.ts";
import { getConfig, setConfigKey } from "../../../config/loader.ts";
import {
  type MockOAuthServer,
  startMockOAuthServer,
} from "../../../credentials/oauth2/tests/mock-server.ts";
import {
  auditLog,
  connectorOauthStates,
  connectors,
  conversationElicitations,
  conversations,
  credentials,
  events,
  sessions,
} from "../../../db/schema/index.ts";
import { now } from "../../../utils/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let mock: MockOAuthServer;
let connectorId: string;
// The configured address is process-wide; hand it back as it was found.
let publicBaseUrlBefore = "";

beforeAll(async () => {
  server = await createHttpTestServer("oauth-callback");
  // The return address is built from the engine's own configured origin.
  publicBaseUrlBefore = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
  mock = await startMockOAuthServer();
  const [row] = await server.db
    .insert(connectors)
    .values({
      tenant_id: server.tenantId,
      slug: "mock-oauth-svc",
      display_name: "Mock OAuth service",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://mock-oauth.test",
      config: {
        oauth: {
          issuer_url: mock.baseUrl,
          authorization_endpoint: `${mock.baseUrl}/authorize`,
          token_endpoint: `${mock.baseUrl}/token`,
          client_id: "test-client",
          client_secret: "test-secret",
          scope: "read",
          use_pkce: false,
        },
      },
    })
    .returning();
  if (!row) throw new Error("seed connector failed");
  connectorId = row.id;
});

afterAll(async () => {
  await setConfigKey("server.public_base_url", publicBaseUrlBefore, { force: true });
  await mock.close();
  await server.cleanup();
});

async function seedStateRow(
  state: string,
  opts: { origin?: string | null; requested_scopes?: string } = {},
): Promise<void> {
  await server.db.insert(connectorOauthStates).values({
    tenant_id: server.tenantId,
    connector_id: connectorId,
    state,
    code_verifier: "",
    redirect_uri: `${server.baseUrl}/v1/oauth/callback`,
    origin: opts.origin ?? null,
    requested_scopes: opts.requested_scopes ?? null,
    // The callback route checks `expires_at > now()`; use the
    // production clock seam (not `Date.now`) so the determinism gate
    // is happy AND tests that install `setTestNow` still observe the
    // same wall.
    expires_at: new Date(now() + 5 * 60_000),
  });
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

async function getStateRow(state: string) {
  const rows = await server.db
    .select()
    .from(connectorOauthStates)
    .where(eq(connectorOauthStates.state, state))
    .limit(1);
  return rows[0] ?? null;
}

/** The connector as the prod incident left it: flagged, breaker open, and —
 *  when asked — switched off by an operator. */
async function breakConnector(opts: { enabled?: boolean } = {}): Promise<void> {
  await server.db
    .update(connectors)
    .set({
      enabled: opts.enabled ?? true,
      needs_reauth: true,
      auth_failed_at: new Date(now() - 90 * 86_400_000),
      auth_failed_reason: "credential rejected",
      circuit_state: "open",
      circuit_failure_count: 44,
      circuit_opened_at: new Date(now() - 90 * 86_400_000),
    })
    .where(eq(connectors.id, connectorId));
}

async function getConnectorRow() {
  const [row] = await server.db.select().from(connectors).where(eq(connectors.id, connectorId));
  if (!row) throw new Error("connector row missing");
  return row;
}

/** The connector as the API hands it out — what the Cockpit page reads. */
async function getConnectorApi(): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}`, {
    headers: { authorization: `Bearer ${server.apiKey}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function auditActions(): Promise<string[]> {
  const rows = await server.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, server.tenantId), eq(auditLog.resource_id, connectorId)));
  return rows.map((row) => row.action);
}

/** A live Cockpit session: the cookie alone (what a browser sends to the
 *  callback) and the headers the Cockpit's own requests carry. */
async function cockpitSession(): Promise<{ cookie: string; headers: Record<string, string> }> {
  const [session] = await server.db
    .insert(sessions)
    .values({
      tenant_id: server.tenantId,
      user_id: server.userId,
      expires_at: new Date(now() + 60 * 60_000),
      absolute_expires_at: new Date(now() + 60 * 60_000),
      last_seen_at: new Date(now()),
    })
    .returning();
  if (!session) throw new Error("browser session seed failed");
  const payload = { tenant_id: server.tenantId, user_id: server.userId, session_id: session.id };
  const cookie = browserSessionCookie(await signBrowserSession(payload));
  return {
    cookie,
    headers: {
      cookie,
      "x-subkit-csrf": await signBrowserCsrf(payload),
      "x-subkit-client": "cockpit",
    },
  };
}

const callback = (query: string, init?: RequestInit) =>
  fetch(`${server.baseUrl}/v1/oauth/callback?${query}`, { redirect: "manual", ...init });

const connectorPage = () => `${server.baseUrl}/cockpit/connectors/${connectorId}`;

describe("GET /v1/oauth/callback", () => {
  test("happy path persists the credential and deletes the state row", async () => {
    const state = "state-happy-path-1";
    await seedStateRow(state);
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
        summary: "Authorize connector",
        input: {
          connector_id: connectorId,
          authorization_url: `${server.baseUrl}/oauth/start`,
        },
        protocol_native: true,
        delivery_last_error: "url_accepted",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");
    const code = "test-code-stub";
    const res = await callback(`state=${state}&code=${code}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const body = await res.text();
    expect(body).toContain("Signed in");
    expect(body).toContain("“Mock OAuth service” is signed in.");

    const cred = await getCredentialRow();
    expect(cred).not.toBeNull();
    expect(cred!.mode).toBe("oauth2");

    expect(await getStateRow(state)).toBeNull();
    const [completedElicitation] = await server.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(completedElicitation?.delivery_last_error).toBe("url_completed");

    // v4.8.0 Fix #1: callback must also publish
    // `connector.oauth.callback_succeeded` on the `connector.oauth`
    // channel so sk-cli can auto-resume the in-flight conversation.
    // Assert the events row exists with the documented payload shape.
    const eventRows = await server.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.tenant_id, server.tenantId),
          eq(events.channel, "connector.oauth"),
          eq(events.type, "connector.oauth.callback_succeeded"),
        ),
      );
    expect(eventRows.length).toBe(1);
    const payload = eventRows[0]!.payload as Record<string, unknown>;
    expect(payload.connector_id).toBe(connectorId);
    expect(payload.source).toBe("oauth_callback");
    expect(typeof payload.connector_slug).toBe("string");
    expect(typeof payload.has_refresh_token).toBe("boolean");
  });

  test("a stored credential clears the sign-in flag and resets the breaker, each audited", async () => {
    await breakConnector();
    const state = "state-resolves-what-it-exists-for";
    await seedStateRow(state);

    const res = await callback(`state=${state}&code=c`);
    expect(res.status).toBe(200);

    const row = await getConnectorRow();
    expect(row.needs_reauth).toBe(false);
    expect(row.auth_failed_at).toBeNull();
    expect(row.auth_failed_reason).toBeNull();
    expect(row.circuit_state).toBe("closed");
    expect(row.circuit_failure_count).toBe(0);
    expect(row.circuit_opened_at).toBeNull();

    // What the connector page reads, not only the columns behind it.
    const api = await getConnectorApi();
    expect(api.needs_reauth).toBe(false);
    expect(api.auth_failed_at).toBeNull();
    expect(api.health_state).toBe("ok");
    expect(api.circuit_state).toBe("closed");
    expect(api.circuit_failure_count).toBe(0);
    expect(api.circuit_opened_at).toBeNull();

    const actions = await auditActions();
    expect(actions).toContain("connector.reauth_cleared");
    expect(actions).toContain("connector.circuit_reset");
  });

  test("a healthy connector signs in again without a second round of audit rows", async () => {
    const before = (await auditActions()).filter(
      (action) => action === "connector.reauth_cleared" || action === "connector.circuit_reset",
    ).length;
    const state = "state-nothing-to-resolve";
    await seedStateRow(state);
    expect((await callback(`state=${state}&code=c`)).status).toBe(200);
    const after = (await auditActions()).filter(
      (action) => action === "connector.reauth_cleared" || action === "connector.circuit_reset",
    ).length;
    expect(after).toBe(before);
  });

  test("switched off and flagged: signing in resolves the flag and leaves it switched off, and says so", async () => {
    await breakConnector({ enabled: false });
    const state = "state-disabled";
    await seedStateRow(state);

    const res = await callback(`state=${state}&code=c`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Signed in");
    expect(body).toContain("switched off and stays off until someone switches it on");
    // A terminal flow is told how to switch it on from the terminal.
    expect(body).toContain("sk connectors enable");

    const row = await getConnectorRow();
    expect(row.enabled).toBe(false);
    expect(row.needs_reauth).toBe(false);
    expect(row.circuit_state).toBe("closed");
    expect(row.circuit_failure_count).toBe(0);
    expect(row.circuit_opened_at).toBeNull();

    await server.db.update(connectors).set({ enabled: true }).where(eq(connectors.id, connectorId));
  });

  test("switched off, in German, from a conversation: no terminal, no command", async () => {
    await breakConnector({ enabled: false });
    const state = "state-disabled-de";
    await seedStateRow(state, { origin: "chat" });

    const res = await callback(`state=${state}&code=c`, {
      headers: { "accept-language": "de-DE,de;q=0.9,en;q=0.5" },
    });
    const body = await res.text();
    expect(body).toContain('<html lang="de">');
    expect(body).toContain("„Mock OAuth service“ ist angemeldet.");
    expect(body).toContain("abgeschaltet und bleibt es, bis ihn jemand einschaltet");
    expect(body).toContain("zur Unterhaltung zurückkehren");
    expect(body).not.toContain("Terminal");
    expect(body).not.toContain("sk connectors enable");
    expect((await getConnectorRow()).enabled).toBe(false);

    await server.db.update(connectors).set({ enabled: true }).where(eq(connectors.id, connectorId));
  });

  test("a partial grant still clears the flag and names what was withheld", async () => {
    await breakConnector();
    const state = "state-partial-grant";
    await seedStateRow(state, { requested_scopes: "read mail.send" });
    mock.setGrantedScope("read");
    try {
      const res = await callback(`state=${state}&code=c`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("did not grant every permission");
      expect(body).toContain("Missing: mail.send.");
    } finally {
      mock.setGrantedScope(null);
    }
    expect((await getConnectorRow()).needs_reauth).toBe(false);
  });

  test("the connector's credential read names the withheld permissions, for the page", async () => {
    const summary = async () => {
      const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/credential`, {
        headers: { authorization: `Bearer ${server.apiKey}` },
      });
      return (await res.json()) as { missing_scopes: string[] };
    };
    // The connector asks for `read`; this sign-in was granted something else.
    await seedStateRow("state-summary-partial", { requested_scopes: "read" });
    mock.setGrantedScope("profile");
    try {
      await callback("state=state-summary-partial&code=c");
    } finally {
      mock.setGrantedScope(null);
    }
    expect((await summary()).missing_scopes).toEqual(["read"]);

    await seedStateRow("state-summary-full", { requested_scopes: "read" });
    mock.setGrantedScope("read profile");
    try {
      await callback("state=state-summary-full&code=c");
    } finally {
      mock.setGrantedScope(null);
    }
    expect((await summary()).missing_scopes).toEqual([]);
  });

  test("a grant reported as a comma list is the full grant, stored space-separated", async () => {
    const state = "state-scope-commas";
    await seedStateRow(state, { requested_scopes: "openid profile read" });
    mock.setGrantedScope("read,openid,profile");
    let body: string;
    try {
      body = await (await callback(`state=${state}&code=c`)).text();
    } finally {
      mock.setGrantedScope(null);
    }
    expect(body).toContain("Signed in");
    expect(body).not.toContain("did not grant");
    expect((await getCredentialRow())?.granted_scopes).toBe("read openid profile");
    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/credential`, {
      headers: { authorization: `Bearer ${server.apiKey}` },
    });
    expect(((await res.json()) as { missing_scopes: string[] }).missing_scopes).toEqual([]);
  });

  test("a provider that reports no scope granted what was asked: not a partial grant", async () => {
    const state = "state-scope-omitted";
    await seedStateRow(state, { requested_scopes: "read mail.send" });
    const body = await (await callback(`state=${state}&code=c`)).text();
    expect(body).toContain("Signed in");
    expect(body).not.toContain("did not grant");
  });

  test("a terminal flow returns to the terminal and is shown no Cockpit link", async () => {
    const state = "state-cli";
    await seedStateRow(state, { origin: "cli" });
    const body = await (await callback(`state=${state}&code=c`)).text();
    expect(body).toContain("return to the terminal");
    expect(body).not.toContain("conversation");
    expect(body).not.toContain("auth-result-link");
    expect(body).not.toContain("/cockpit/connectors/");
  });

  test("a state row from before the origin column reads as a terminal flow", async () => {
    const state = "state-legacy";
    await seedStateRow(state, { origin: null });
    const body = await (await callback(`state=${state}&code=c`)).text();
    expect(body).toContain("return to the terminal");
  });

  test("a conversation flow returns to the conversation; the Cockpit link needs a live session", async () => {
    await seedStateRow("state-chat-anonymous", { origin: "chat" });
    const anonymous = await (await callback("state=state-chat-anonymous&code=c")).text();
    expect(anonymous).toContain("return to the conversation");
    expect(anonymous).not.toContain("terminal");
    expect(anonymous).not.toContain("auth-result-link");

    const { cookie } = await cockpitSession();
    await seedStateRow("state-chat-session", { origin: "chat" });
    const signedIn = await (
      await callback("state=state-chat-session&code=c", { headers: { cookie } })
    ).text();
    expect(signedIn).toContain(`href="${connectorPage()}"`);
    expect(signedIn).toContain("Open the connector");
  });

  test("a Cockpit flow is redirected to the connector's page, never to an address from the query", async () => {
    await breakConnector({ enabled: false });
    const state = "state-cockpit";
    await seedStateRow(state, { origin: "cockpit" });

    const hostile =
      "&return_to=https%3A%2F%2Fevil.example%2F&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&next=%2F%2Fevil.example";
    const res = await callback(`state=${state}&code=c${hostile}`, {
      headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${connectorPage()}?signed_in=1`);

    // The redirect is not a way around the switch: the connector is signed
    // in and still off, which is what the page it lands on will read.
    const api = await getConnectorApi();
    expect(api.enabled).toBe(false);
    expect(api.needs_reauth).toBe(false);
    expect(api.circuit_state).toBe("closed");

    await server.db.update(connectors).set({ enabled: true }).where(eq(connectors.id, connectorId));
  });

  test("a failed Cockpit flow gets a page with the way back, and no redirect", async () => {
    const state = "state-cockpit-denied";
    await seedStateRow(state, { origin: "cockpit" });
    const res = await callback(`state=${state}&error=access_denied`, {
      headers: { "accept-language": "de" },
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Anmeldung nicht abgeschlossen");
    expect(body).toContain("Starte die Anmeldung auf der Seite des Konnektors neu.");
    expect(body).toContain(`href="${connectorPage()}"`);
    expect(body).toContain("Zurück zum Konnektor");
    expect(body).not.toContain("signed_in");
  });

  test("provider error returns an HTML error page and deletes the state row", async () => {
    const state = "state-provider-error";
    await seedStateRow(state);
    const res = await callback(
      `state=${state}&error=access_denied&error_description=%3Cb%3Ecall+this+number%3C%2Fb%3E`,
    );
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.status).toBe(400);
    const body = await res.text();
    // The provider's code is shown; its free text — anyone's text, on an
    // unauthenticated URL — is not.
    expect(body).toContain("Provider code: access_denied");
    expect(body).not.toContain("call this number");
    expect(body).toContain("Nothing was stored.");
    expect(await getStateRow(state)).toBeNull();
  });

  test("an error value that is not an error code is not put on the page", async () => {
    const state = "state-provider-error-markup";
    await seedStateRow(state);
    const res = await callback(`state=${state}&error=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
    const body = await res.text();
    expect(res.status).toBe(400);
    expect(body).not.toContain("alert(1)");
    expect(body).not.toContain("Provider code");
  });

  test("state replay: second callback with the same state returns the not-found page", async () => {
    const state = "state-replay";
    await seedStateRow(state);
    const code = "test-code-stub";
    // First call wins (DELETE … RETURNING atomically claims the row).
    const first = await callback(`state=${state}&code=${code}`);
    expect(first.status).toBe(200);
    // Second call sees no row — should render the "link expired" page.
    const second = await callback(`state=${state}&code=ignored`);
    expect(second.status).toBe(400);
    expect(second.headers.get("content-type")).toMatch(/^text\/html/);
    const body = await second.text();
    expect(body).toContain("Link expired");
  });

  test("unknown state returns the same not-found page (no state leakage)", async () => {
    const { cookie } = await cockpitSession();
    const res = await callback("state=does-not-exist&code=x", { headers: { cookie } });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Link expired");
    // Nothing identifies a flow, so the page names no surface and — even for
    // a signed-in browser — links nowhere.
    expect(body).toContain("Start the sign-in again where you began it.");
    expect(body).not.toContain("terminal");
    expect(body).not.toContain("auth-result-link");
  });

  test("an expired state is the same page", async () => {
    await server.db.insert(connectorOauthStates).values({
      tenant_id: server.tenantId,
      connector_id: connectorId,
      state: "state-expired",
      code_verifier: "",
      redirect_uri: `${server.baseUrl}/v1/oauth/callback`,
      origin: "cockpit",
      expires_at: new Date(now() - 1000),
    });
    const res = await callback("state=state-expired&code=x");
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Link expired");
    expect(body).not.toContain("auth-result-link");
  });
});

describe("POST /v1/connectors/{id}/oauth/start records where the flow began", () => {
  async function originOf(state: string): Promise<string | null | undefined> {
    return (await getStateRow(state))?.origin;
  }

  test("an API key is a terminal flow", async () => {
    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/oauth/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.apiKey}` },
    });
    expect(res.status).toBe(200);
    const { state } = (await res.json()) as { state: string };
    expect(await originOf(state)).toBe("cli");
  });

  test("the Cockpit's own request under a live session is a Cockpit flow", async () => {
    const { headers } = await cockpitSession();
    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/oauth/start`, {
      method: "POST",
      headers,
    });
    expect(res.status).toBe(200);
    const { state } = (await res.json()) as { state: string };
    expect(await originOf(state)).toBe("cockpit");
  });

  test("claiming to be the Cockpit with an API key is still a terminal flow", async () => {
    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/oauth/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.apiKey}`, "x-subkit-client": "cockpit" },
    });
    expect(res.status).toBe(200);
    const { state } = (await res.json()) as { state: string };
    expect(await originOf(state)).toBe("cli");
  });
});
