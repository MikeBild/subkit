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
import { browserSessionCookie, signBrowserSession } from "../../../auth/browser-session.ts";
import { getConfig, setConfigKey } from "../../../config/loader.ts";
import { generateCredentialSetupGrant } from "../../../connectors/credential-setup-grant.ts";
import { sha256Hex } from "../../../connectors/oauth-start-grant.ts";
import {
  createEmptyDraftDocument,
  withConnectorDraft,
  withConnectorInspection,
  withConnectorValidation,
} from "../../../conversations/authoring-state.ts";
import { validateConnectorDraft } from "../../../conversations/connector-draft.ts";
import { invokeConversationToolDirect } from "../../../conversations/direct-invoke.ts";
import { appendSnapshot } from "../../../conversations/draft.ts";
import { resolveElicitationAndReactivate } from "../../../conversations/elicitations.ts";
import {
  _resetDraftCredentialCacheForTests,
  getDraftCredential,
} from "../../../conversations/persistence/draft-credential-cache.ts";
import { pauseForUserInput } from "../../../conversations/tools/ask-user/common.ts";
import { getCredentialForConnector } from "../../../credentials/service.ts";
import {
  auditLog,
  connectorCredentialSetupGrants,
  connectors,
  conversationElicitations,
  conversations,
  credentials,
  sessions,
} from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { withDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { now } from "../../../utils/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let connectorId: string;
// The configured address is process-wide; hand it back as it was found.
let publicBaseUrlBefore = "";

beforeAll(async () => {
  server = await createHttpTestServer("credentials-setup-grant");
  publicBaseUrlBefore = getConfig().server.public_base_url;
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
  await setConfigKey("server.public_base_url", publicBaseUrlBefore, { force: true });
  _resetDraftCredentialCacheForTests();
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
    // The page must name the external service on the heading, the explainer,
    // and the secret field — operators must not read it as a sign-in page.
    expect(html).toContain("Reconnect Mock Setup Bearer");
    expect(html).toContain("API token / bearer token issued by Mock Setup Bearer");
    expect(html).toContain("not a sign-in for this page");
    // The product's page shell, not a one-off card.
    expect(html).toContain('data-auth-contract="mcp-auth"');

    const german = await fetch(
      `${server.baseUrl}/v1/connectors/${connectorId}/credentials/setup?grant=${encodeURIComponent(token)}`,
      { headers: { "accept-language": "de" } },
    );
    const germanHtml = await german.text();
    expect(germanHtml).toContain('<html lang="de">');
    expect(germanHtml).toContain("Mock Setup Bearer neu verbinden");
    expect(germanHtml).toContain("API-Token / Bearer-Token von Mock Setup Bearer");
    // The plaintext grant appears EXACTLY once: the hidden form field.
    expect(html.split(token).length - 1).toBe(1);

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
    // "Link", not "Sign-in link" — this page never was a sign-in.
    expect(body).toContain("Link expired");
    expect(body).not.toContain("Sign-in link");
    // A one-time page names no terminal and no conversation.
    expect(body).toContain("Ask for a fresh link where you got this one.");
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
        status: "active",
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
    // Switched off by an operator, breaker open on the old credential.
    await server.db
      .update(connectors)
      .set({
        enabled: false,
        circuit_state: "open",
        circuit_failure_count: 7,
        circuit_opened_at: new Date(now() - 60_000),
      })
      .where(eq(connectors.id, connectorId));

    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/credentials/setup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant: token, token: "new-bearer-secret-value" }).toString(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Credential saved");
    // Storing a credential does not switch the connector on; the page says so.
    expect(html).toContain("switched off and stays off until someone switches it on");
    expect(html).toContain("You can close this page.");

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
    // The breaker counted the replaced credential's failures: closed, clean.
    expect(connectorRow?.circuit_state).toBe("closed");
    expect(connectorRow?.circuit_failure_count).toBe(0);
    expect(connectorRow?.circuit_opened_at).toBeNull();
    expect(connectorRow?.enabled).toBe(false);
    await server.db.update(connectors).set({ enabled: true }).where(eq(connectors.id, connectorId));
    const resetAudit = await server.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, server.tenantId),
          eq(auditLog.action, "connector.circuit_reset"),
        ),
      );
    expect(resetAudit.length).toBe(1);
    // Attributed to the operator who asked for the link, like the flag's row.
    expect(resetAudit[0]?.actor_id).toBe(server.userId);

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

describe("pasted credential whitespace", () => {
  // A key copied with a trailing newline used to be stored verbatim; sent as
  // a header, the runtime then refused it with an error quoting the secret.
  test("the stored bearer token carries no surrounding whitespace", async () => {
    const token = await seedGrant();
    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/credentials/setup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant: token, token: "  pasted-bearer-secret\r\n" }).toString(),
    });
    expect(res.status).toBe(200);
    const stored = await getCredentialForConnector(server.tenantId, connectorId, "dev", server.db);
    expect(stored?.value).toEqual({ mode: "bearer", token: "pasted-bearer-secret" });
  });
});

describe("unsaved connector draft credential setup", () => {
  test("MCP secret prompt → URL setup → green probe → connector and credential persist", async () => {
    const [conversation] = await server.db
      .insert(conversations)
      .values({
        tenant_id: server.tenantId,
        owner_id: server.userId,
        status: "awaiting_input",
      })
      .returning();
    if (!conversation) throw new Error("seed draft conversation failed");
    const startedDraft = withConnectorDraft(
      createEmptyDraftDocument("connector_authoring"),
      {
        name: "Cloudflare Journey",
        slug: "cloudflare-journey",
        driver: "http",
        environment: "prod",
        base_url: "https://api.cloudflare.com/client/v4",
        auth_type: "bearer",
        config: {},
      },
      "connector_draft_started",
    );
    const inspectedDraft = withConnectorInspection(startedDraft);
    const validation = validateConnectorDraft(inspectedDraft.connector ?? null, []);
    const draft = withConnectorValidation(
      inspectedDraft,
      { ...inspectedDraft.connector, validation },
      validation.ok,
      "Connector draft validated.",
    );
    await appendSnapshot(server.tenantId, conversation.id, draft, server.db);

    const askResult = await pauseForUserInput(
      {
        db: server.db,
        tenant_id: server.tenantId,
        conversation_id: conversation.id,
        actor_id: server.userId,
        connector_id: null,
        workflow_id: null,
        engineClient: new EngineClient({
          tenant_id: server.tenantId,
          actor_id: server.userId,
          actor_type: "user",
          db: server.db,
        }),
        getDraft: () => draft,
        setDraft: async (next) => {
          await appendSnapshot(server.tenantId, conversation.id, next, server.db);
        },
        abortSignal: new AbortController().signal,
        surface: "mcp",
      },
      {
        tool_name: "ask_user_form",
        summary: "Enter the Cloudflare token",
        input: {
          question: "Enter the Cloudflare token",
          fields: [{ name: "token", label: "Token", type: "password" }],
        },
      },
    );
    expect(askResult.ok).toBe(true);
    if (!askResult.ok || !askResult.pause) throw new Error("expected secure URL pause");
    expect(askResult.pause.tool_name).toBe("ask_user_confirm");
    const [elicitation] = await server.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, askResult.pause.elicitation_id));
    if (!elicitation) throw new Error("draft elicitation missing");
    const setupUrl = (elicitation.input as { setup_url?: unknown }).setup_url;
    if (typeof setupUrl !== "string") throw new Error("draft setup URL missing");
    const plaintext = new URL(setupUrl).searchParams.get("grant");
    if (!plaintext) throw new Error("draft setup grant missing");

    const form = await fetch(setupUrl);
    expect(form.status).toBe(200);
    const formHtml = await form.text();
    expect(formHtml).toContain('name="token"');
    // Draft flow is a first-time connect, not a reauth.
    expect(formHtml).toContain("Connect Cloudflare Journey");
    expect(formHtml).toContain("API token / bearer token issued by Cloudflare Journey");

    const [browserSession] = await server.db
      .insert(sessions)
      .values({
        tenant_id: server.tenantId,
        user_id: server.userId,
        token_sha256: `credential-setup-${conversation.id}`,
        expires_at: new Date(now() + 60 * 60_000),
        absolute_expires_at: new Date(now() + 24 * 60 * 60_000),
        last_seen_at: new Date(now()),
      })
      .returning({ id: sessions.id });
    if (!browserSession) throw new Error("browser session seed failed");
    const browserCookie = browserSessionCookie(
      await signBrowserSession({
        session_id: browserSession.id,
        user_id: server.userId,
        tenant_id: server.tenantId,
      }),
    );

    const submitted = await fetch(
      `${server.baseUrl}/v1/connector-drafts/${conversation.id}/credentials/setup`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: browserCookie,
        },
        body: new URLSearchParams({
          grant: plaintext,
          token: "fresh-cloudflare-token-123",
        }).toString(),
      },
    );
    expect(submitted.status).toBe(200);
    expect(await submitted.text()).toContain("Credential received");
    expect(getDraftCredential(conversation.id)).toEqual({
      mode: "bearer",
      token: "fresh-cloudflare-token-123",
    });

    const resolved = await resolveElicitationAndReactivate(
      {
        tenant_id: server.tenantId,
        conversation_id: conversation.id,
        id: elicitation.id,
        output: { confirmed: true },
        decided_by: server.userId,
        reason: "credential_setup_completed",
        transport: "succeeded",
      },
      server.db,
    );
    expect(resolved.kind).toBe("resolved");

    const observed: { authorization: string | null; url: string | null } = {
      authorization: null,
      url: null,
    };
    const probeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      observed.url = input.toString();
      observed.authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const probe = await withDriverFetchForTests(probeFetch, () =>
      invokeConversationToolDirect({
        db: server.db,
        tenant_id: server.tenantId,
        conversation_id: conversation.id,
        actor_id: server.userId,
        tool: "probe_connector_draft",
        args: {
          method: "GET",
          path: "/accounts/test-account/tokens/verify",
          environment: "prod",
          timeout_ms: 5_000,
        },
      }),
    );
    expect(probe.ok).toBe(true);
    expect(observed.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-account/tokens/verify",
    );
    expect(observed.authorization).toBe("Bearer fresh-cloudflare-token-123");

    const persisted = await server.db
      .select()
      .from(connectors)
      .where(eq(connectors.slug, "cloudflare-journey"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.environment).toBe("prod");
    const persistedCredentials = await server.db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, server.tenantId),
          eq(credentials.connector_id, persisted[0]!.id),
          eq(credentials.environment, "prod"),
        ),
      );
    expect(persistedCredentials).toHaveLength(1);
    expect(getDraftCredential(conversation.id)).toBeNull();

    const [completed] = await server.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(completed?.delivery_last_error).toBe("url_completed");

    const replay = await fetch(
      `${server.baseUrl}/v1/connector-drafts/${conversation.id}/credentials/setup`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant: plaintext, token: "replacement" }).toString(),
      },
    );
    expect(replay.status).toBe(400);
    expect(getDraftCredential(conversation.id)).toBeNull();
  });
});
