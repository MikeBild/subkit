import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { browserSessionFromRequest, issueBrowserSession } from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { setConfigKey } from "../../config/loader.ts";
import { auditLog, connectors, sessions, toolApprovals } from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { requestApproval } from "../../tools/approval.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

const nextApprovalId = createDeterministicUuidFactory(0x70724c);
const ONE_SECOND_AGO = new Date(1_699_999_999_000);

let server: HttpTestServer;
let requester: ResolvedPrincipal;
let browserCookie: string;

async function signIn(): Promise<string> {
  const login = await issueBrowserSession({
    db: server.db,
    tenantId: server.tenantId,
    userId: server.userId,
    redirectTo: server.baseUrl,
    via: "approval_portal_test",
  });
  const cookie = login.headers.get("set-cookie");
  if (!cookie) throw new Error("browser session was not issued");
  return cookie;
}

const SECRET_ARG_VALUE = "TOTALLY-SECRET-ARG-VALUE-4f9c1e";

beforeAll(async () => {
  server = await createHttpTestServer("tool-approvals-portal");
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
  browserCookie = await signIn();
  requester = {
    provider: "api_key",
    kind: "system_account",
    id: server.systemAccountId,
    tenant_id: server.tenantId,
    roles: [],
  };
});

afterAll(async () => {
  await server.cleanup();
});

async function seedApproval(opts?: {
  tool?: string;
  would_write?: Array<{ step: string; method: string; url: string }>;
  args?: Record<string, unknown>;
}): Promise<{ approval_id: string; approval_url: string }> {
  const approval_id = nextApprovalId();
  const { approval_url } = await requestApproval({
    db: server.db,
    principal: requester,
    approval_id,
    tool: opts?.tool ?? "wf_post_ledger_entries",
    surface: "mcp",
    via: "mcp",
    reason: "held_writes",
    execution_mode: "dev",
    args: opts?.args ?? { workflow: "x", token: SECRET_ARG_VALUE },
    preview: {
      would_write: opts?.would_write ?? [
        { step: "post_ledger", method: "POST", url: "https://ledger.example.test/entries" },
      ],
    },
  });
  if (!approval_url) throw new Error("seed approval did not mint a portal link");
  return { approval_id, approval_url };
}

function grantParam(url: string): string {
  return new URL(url).searchParams.get("grant") ?? "";
}

function expectPortalActors(html: string, locale: "de" | "en"): void {
  expect(html).toContain(locale === "de" ? "<dt>Angefragt von</dt>" : "<dt>Requested by</dt>");
  expect(html).toContain(
    locale === "de"
      ? "<dd>bot-tool-approvals-portal · Systemkonto</dd>"
      : "<dd>bot-tool-approvals-portal · System account</dd>",
  );
  expect(html).toContain(locale === "de" ? "<dt>Entscheidet</dt>" : "<dt>Deciding person</dt>");
  expect(html).toContain("<dd>admin-tool-approvals-portal@test.local</dd>");
}

async function approvalRow(approval_id: string) {
  const rows = await server.db
    .select()
    .from(toolApprovals)
    .where(eq(toolApprovals.id, approval_id));
  return rows[0] ?? null;
}

describe("GET /v1/tool-approvals/decide?grant=…", () => {
  for (const locale of ["de", "en"] as const) {
    test(`renders a finite, truthful decision boundary in ${locale}`, async () => {
      const { approval_id, approval_url } = await seedApproval();
      const response = await fetch(approval_url, {
        headers: { cookie: browserCookie, "accept-language": locale },
      });
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(`<html lang="${locale}">`);
      expect(html).toContain('data-approval-product="subkit"');
      expect(html).toContain("mcp-auth-ui-contract");
      expect(html).toContain("10");
      expect(html).toContain("UTC");
      expect(html).toContain(locale === "de" ? "Bindung" : "Binding");
      expect(html).toContain(locale === "de" ? "Angefragt von" : "Requested by");
      expect(html).toContain(locale === "de" ? "Systemkonto" : "System account");
      expect(html).not.toContain(server.systemAccountId);
      expect(html).not.toContain("Nothing has run");
      expect(html).not.toContain("expires shortly");
      expect(html).not.toContain(approval_id);
      expect(html).not.toContain("<script");
      expect((await approvalRow(approval_id))?.granted_at).toBeNull();
    });
  }

  test("the cockpit's language and theme cookies win over the browser's language", async () => {
    const { approval_url } = await seedApproval();
    const response = await fetch(approval_url, {
      headers: {
        cookie: `${browserCookie}; sk_locale=de; sk_theme=dark`,
        "accept-language": "en-US,en;q=0.9",
      },
    });
    const html = await response.text();
    expect(html).toContain('<html lang="de" class="dark">');
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self'");
  });

  test("language switching preserves the pending decision and its expiry", async () => {
    const { approval_id, approval_url } = await seedApproval();
    const page = await fetch(approval_url, { headers: { cookie: browserCookie } });
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const before = await approvalRow(approval_id);
    for (const language of ["de", "en"]) {
      const response = await fetch(`${server.baseUrl}/v1/tool-approvals/decide`, {
        method: "POST",
        headers: { cookie: browserCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant: grantParam(approval_url), csrf_token: csrf, language }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`<html lang="${language}">`);
      expect(response.headers.get("set-cookie")).toMatch(
        new RegExp(`^sk_locale=${language}; Path=/; Max-Age=\\d+; SameSite=Lax`),
      );
      expect(response.headers.get("set-cookie")).not.toContain("HttpOnly");
    }
    const after = await approvalRow(approval_id);
    expect(after?.expires_at).toEqual(before?.expires_at);
    expect(after?.granted_at).toBeNull();
    expect(after?.declined_at).toBeNull();
    expect(after?.consumed_at).toBeNull();
    const decisions = await server.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, server.tenantId), eq(auditLog.resource_id, approval_id)));
    expect(decisions.map((row) => row.action)).toEqual(["approval.requested"]);
  });

  test("renders would_write, and never the decrypted args or the ciphertext", async () => {
    const { approval_id, approval_url } = await seedApproval();

    const res = await fetch(approval_url, {
      headers: { cookie: browserCookie, "accept-language": "en" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();

    expect(html).toContain("post_ledger");
    expect(html).toContain("POST");
    expect(html).toContain("ledger.example.test/entries");

    expect(html).not.toContain(SECRET_ARG_VALUE);
    expectPortalActors(html, "en");
    expect(html).toContain('<h1 data-family-slot="auth-heading">Allow this action once?</h1>');
    expect(html).not.toContain("Allow POST to");
    const german = await fetch(approval_url, {
      headers: { cookie: browserCookie, "accept-language": "de" },
    });
    const germanHtml = await german.text();
    expect(german.status).toBe(200);
    expectPortalActors(germanHtml, "de");
    expect(germanHtml).toContain(
      '<h1 data-family-slot="auth-heading">Diese Aktion einmal erlauben?</h1>',
    );
    expect(germanHtml).not.toContain("POST an ledger.example.test");

    const row = await approvalRow(approval_id);
    expect(row).not.toBeNull();
    const cipherB64 = Buffer.from(row!.args_ciphertext).toString("base64");
    const cipherHex = Buffer.from(row!.args_ciphertext).toString("hex");
    expect(html).not.toContain(cipherB64);
    expect(html.toLowerCase()).not.toContain(cipherHex.slice(0, 24));

    expect(row?.granted_at).toBeNull();
    expect(row?.declined_at).toBeNull();
  });

  test("derives the title from a captured direct-connector effect, not caller preview text", async () => {
    const connector_id = nextApprovalId();
    await server.db.insert(connectors).values({
      id: connector_id,
      tenant_id: server.tenantId,
      slug: "approval-title-target",
      display_name: "Approval title target",
      driver: "http",
      auth_type: "none",
      environment: "dev",
      base_url: "https://bound-ledger.example.test",
    });
    const { approval_id, approval_url } = await seedApproval({
      tool: "call_connector",
      args: { connector_id, method: "POST", path: "/entries" },
      would_write: [{ step: "caller-text", method: "DELETE", url: "https://unbound.example.test" }],
    });

    for (const locale of ["de", "en"] as const) {
      const response = await fetch(approval_url, {
        headers: { cookie: browserCookie, "accept-language": locale },
      });
      const html = await response.text();
      expect(response.status).toBe(200);
      expectPortalActors(html, locale);
      expect(html).toContain(
        locale === "de"
          ? '<h1 data-family-slot="auth-heading">POST an https://bound-ledger.example.test/entries einmal erlauben?</h1>'
          : '<h1 data-family-slot="auth-heading">Allow POST to https://bound-ledger.example.test/entries once?</h1>',
      );
      expect(html).toContain("bound-ledger.example.test/entries");
      expect(html).not.toContain("caller-text");
      expect(html).not.toContain("unbound.example.test");
    }
    expect((await approvalRow(approval_id))?.granted_at).toBeNull();
  });

  test("renders for a signed-in browser session whose cookie carries no email", async () => {
    const { approval_url } = await seedApproval();
    const login = await issueBrowserSession({
      db: server.db,
      tenantId: server.tenantId,
      userId: server.userId,
      redirectTo: approval_url,
      via: "approval_portal_test",
    });
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toBeTruthy();

    const res = await fetch(approval_url, { headers: { cookie: cookie ?? "" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("admin-tool-approvals-portal@test.local");
    expect(html).toContain("post_ledger");
  });

  test("a forged grant token is rejected", async () => {
    const res = await fetch(
      `${server.baseUrl}/v1/tool-approvals/decide?grant=${encodeURIComponent("skag_not-a-real-token-0000000000000000")}`,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("expired");
  });

  test("a cut-short or missing grant shows the dead-link page with one way back", async () => {
    for (const query of ["?grant=skag_cut", "?grant=", ""]) {
      const res = await fetch(`${server.baseUrl}/v1/tool-approvals/decide${query}`, {
        headers: { accept: "text/html" },
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("expired");
      expect(html.match(/<a /g)).toHaveLength(1);
    }
  });

  test("an expired grant is rejected", async () => {
    const { approval_id, approval_url } = await seedApproval();
    await server.db
      .update(toolApprovals)
      .set({ expires_at: ONE_SECOND_AGO })
      .where(eq(toolApprovals.id, approval_id));

    const res = await fetch(approval_url);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("expired");
  });

  test("an unidentified browser is sent to sign in, and sees no write preview", async () => {
    const { approval_url } = await seedApproval();

    const res = await fetch(approval_url, { redirect: "manual" });
    expect([302, 200]).toContain(res.status);
    const body = res.status === 302 ? (res.headers.get("location") ?? "") : await res.text();
    expect(body).toContain("/v1/identity/login/start");
    expect(body).not.toContain("post_ledger");
    expect(body).not.toContain(SECRET_ARG_VALUE);
  });

  test("GET without a grant param → 400 (Zod validation)", async () => {
    const res = await fetch(`${server.baseUrl}/v1/tool-approvals/decide`);
    expect(res.status).toBe(400);
  });
});

async function decide(
  grant: string,
  decision: "approve" | "decline",
  opts: { authenticated?: boolean; csrf?: string } = {},
): Promise<Response> {
  const authenticated = opts.authenticated ?? true;
  const headers: Record<string, string> = authenticated ? { cookie: browserCookie } : {};
  let csrf = opts.csrf;
  if (csrf === undefined) {
    const page = await fetch(
      `${server.baseUrl}/v1/tool-approvals/decide?grant=${encodeURIComponent(grant)}`,
      { headers },
    );
    csrf = /name="csrf_token" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  }
  return await fetch(`${server.baseUrl}/v1/tool-approvals/decide`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant, decision, csrf_token: csrf }).toString(),
  });
}

describe("POST /v1/tool-approvals/decide", () => {
  for (const locale of ["de", "en"] as const) {
    test(`a decision-time expiry renders its specific server result in ${locale}`, async () => {
      const { approval_id, approval_url } = await seedApproval();
      const opened = await fetch(approval_url, {
        headers: { cookie: browserCookie, "accept-language": locale },
        signal: AbortSignal.timeout(5_000),
      });
      expect(opened.status).toBe(200);
      const csrf = /name="csrf_token" value="([^"]+)"/.exec(await opened.text())?.[1];
      expect(csrf).toBeTruthy();
      const blocker = await server.testDb.pool.connect();
      let transactionOpen = false;
      let pending: Promise<PromiseSettledResult<Response>[]> | undefined;
      let results: PromiseSettledResult<Response>[] = [];
      try {
        await blocker.query("BEGIN");
        transactionOpen = true;
        const locked = await blocker.query<{ id: string }>(
          "SELECT id FROM tool_approvals WHERE tenant_id = $1 AND id = $2 AND expires_at > now() FOR UPDATE",
          [server.tenantId, approval_id],
        );
        expect(locked.rows).toHaveLength(1);
        const pid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const blockerPid = pid.rows[0]?.pid;
        expect(blockerPid).toBeDefined();
        pending = Promise.allSettled([
          fetch(`${server.baseUrl}/v1/tool-approvals/decide`, {
            method: "POST",
            signal: AbortSignal.timeout(5_000),
            headers: {
              cookie: browserCookie,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant: grantParam(approval_url),
              csrf_token: csrf ?? "",
              decision: "approve",
              language: locale,
            }).toString(),
          }),
        ]);
        await waitFor(
          async () => {
            const { rows } = await server.testDb.pool.query<{ waiting: number }>(
              `SELECT count(*)::integer AS waiting FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock'
                 AND query ILIKE '%update%tool_approvals%'
                 AND $1::integer = ANY(pg_blocking_pids(pid))`,
              [blockerPid],
            );
            return rows[0]?.waiting === 1;
          },
          {
            label: "authenticated approval decision waiting on its held row",
            tries: 200,
            sleepMs: 5,
          },
        );
        const expired = await blocker.query(
          "UPDATE tool_approvals SET expires_at = $3 WHERE tenant_id = $1 AND id = $2",
          [server.tenantId, approval_id, ONE_SECOND_AGO],
        );
        expect(expired.rowCount).toBe(1);
        await blocker.query("COMMIT");
        transactionOpen = false;
      } finally {
        if (transactionOpen) await blocker.query("ROLLBACK");
        blocker.release();
        if (pending) results = await pending;
      }
      const result = results[0];
      if (!result || result.status !== "fulfilled") throw new Error("approval HTTP request failed");
      expect(result.value.status).toBe(400);
      const html = await result.value.text();
      expect(html).toContain(locale === "de" ? "Frist abgelaufen" : "Deadline expired");
      expect(html).not.toContain(
        locale === "de" ? "Link abgelaufen oder nicht verfügbar" : "Link expired or unavailable",
      );
      const row = await approvalRow(approval_id);
      expect(row?.granted_at).toBeNull();
      expect(row?.declined_at).toBeNull();
      expect(row?.consumed_at).toBeNull();
      const audits = await server.db
        .select({ action: auditLog.action, result: auditLog.result, reason: auditLog.reason })
        .from(auditLog)
        .where(and(eq(auditLog.tenant_id, server.tenantId), eq(auditLog.resource_id, approval_id)));
      expect(
        audits.some(
          (audit) =>
            audit.action === "approval.granted" &&
            audit.result === "denied" &&
            audit.reason === "approval_expired",
        ),
      ).toBe(true);
      expect(
        audits.some((audit) => audit.action === "approval.granted" && audit.result === "success"),
      ).toBe(false);
    }, 30_000);
  }

  for (const locale of ["de", "en"] as const) {
    test(`expiry after opening keeps token submission neutral in ${locale}`, async () => {
      const { approval_id, approval_url } = await seedApproval();
      const opened = await fetch(approval_url, {
        headers: { cookie: browserCookie, "accept-language": locale },
        signal: AbortSignal.timeout(5_000),
      });
      expect(opened.status).toBe(200);
      const csrf = /name="csrf_token" value="([^"]+)"/.exec(await opened.text())?.[1];
      expect(csrf).toBeTruthy();
      await server.db
        .update(toolApprovals)
        .set({ expires_at: ONE_SECOND_AGO })
        .where(
          and(eq(toolApprovals.tenant_id, server.tenantId), eq(toolApprovals.id, approval_id)),
        );
      const submitted = await fetch(`${server.baseUrl}/v1/tool-approvals/decide`, {
        method: "POST",
        signal: AbortSignal.timeout(5_000),
        headers: { cookie: browserCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant: grantParam(approval_url),
          csrf_token: csrf ?? "",
          decision: "approve",
          language: locale,
        }).toString(),
      });
      expect(submitted.status).toBe(400);
      const expected =
        locale === "de" ? "Link abgelaufen oder nicht verfügbar" : "Link expired or unavailable";
      const html = await submitted.text();
      expect(html).toContain(expected);
      expect(html).not.toContain(locale === "de" ? "Frist abgelaufen" : "Deadline expired");
      const expiredGet = await fetch(approval_url, {
        headers: { "accept-language": locale },
        signal: AbortSignal.timeout(5_000),
      });
      const unknownGet = await fetch(
        `${server.baseUrl}/v1/tool-approvals/decide?grant=skag_not-a-real-token-0000000000000000`,
        { headers: { "accept-language": locale }, signal: AbortSignal.timeout(5_000) },
      );
      expect(expiredGet.status).toBe(400);
      expect(unknownGet.status).toBe(400);
      expect(await expiredGet.text()).toBe(await unknownGet.text());
      const row = await approvalRow(approval_id);
      expect(row?.granted_at).toBeNull();
      expect(row?.declined_at).toBeNull();
      expect(row?.consumed_at).toBeNull();
    }, 30_000);
  }

  test("a user-owned API key cannot render or submit a human approval", async () => {
    const { approval_id, approval_url } = await seedApproval();
    const headers = { authorization: `Bearer ${server.apiKey}` };
    const page = await fetch(approval_url, { headers, redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toContain("/v1/identity/login/start");
    expect(await page.text()).not.toContain('name="csrf_token"');
    const response = await fetch(`${server.baseUrl}/v1/tool-approvals/decide`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant: grantParam(approval_url),
        decision: "approve",
        csrf_token: "",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Sign in");
    expect((await approvalRow(approval_id))?.granted_at).toBeNull();
  });

  for (const invalidation of ["revoked", "expired"] as const) {
    test(`a ${invalidation} browser session cannot fall back to a user API key`, async () => {
      const { approval_id, approval_url } = await seedApproval();
      const cookie = await signIn();
      const headers = { cookie, authorization: `Bearer ${server.apiKey}` };
      const page = await fetch(approval_url, { headers });
      expect(page.status).toBe(200);
      const csrf = /name="csrf_token" value="([^"]+)"/.exec(await page.text())?.[1];
      expect(csrf).toBeTruthy();
      const session = await browserSessionFromRequest(new Request(approval_url, { headers }));
      if (!session) throw new Error("signed browser session did not resolve");
      await server.db
        .update(sessions)
        .set(
          invalidation === "revoked"
            ? { revoked_at: ONE_SECOND_AGO }
            : { absolute_expires_at: ONE_SECOND_AGO },
        )
        .where(and(eq(sessions.tenant_id, server.tenantId), eq(sessions.id, session.session_id)));
      const response = await fetch(`${server.baseUrl}/v1/tool-approvals/decide`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant: grantParam(approval_url),
          decision: "approve",
          csrf_token: csrf ?? "",
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Sign in");
      expect((await approvalRow(approval_id))?.granted_at).toBeNull();
      const reopened = await fetch(approval_url, { headers, redirect: "manual" });
      expect(reopened.status).toBe(302);
    });
  }

  test("approve grants once, and the token dies — a second decision on the same token is refused", async () => {
    const { approval_id, approval_url } = await seedApproval();
    const grant = grantParam(approval_url);

    const res = await decide(grant, "approve");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Allowed once");

    const row = await approvalRow(approval_id);
    expect(row?.granted_at).not.toBeNull();
    expect(row?.granted_by_user_id).toBe(server.userId);
    expect(row?.granted_by_user_id).not.toBe(requester.id);
    expect(row?.granted_via).toBe("portal");

    const granted = await server.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resource_id, approval_id));
    const grantedRow = granted.find((r) => r.action === "approval.granted");
    expect(grantedRow).toBeDefined();
    expect(grantedRow?.actor_id).toBe(server.userId);

    const replay = await decide(grant, "approve");
    expect(replay.status).toBe(400);
    const replayHtml = await replay.text();
    expect(replayHtml).not.toContain("Approved</h1>");

    const rowAfterReplay = await approvalRow(approval_id);
    expect(rowAfterReplay?.granted_at).toEqual(row?.granted_at);
  });

  test("decline is terminal — a subsequent decision is refused and the approval stays declined", async () => {
    const { approval_id, approval_url } = await seedApproval();
    const grant = grantParam(approval_url);

    const res = await decide(grant, "decline");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Declined");

    const row = await approvalRow(approval_id);
    expect(row?.declined_at).not.toBeNull();
    expect(row?.granted_at).toBeNull();

    const secondDecision = await decide(grant, "approve");
    expect(secondDecision.status).toBe(400);
    const secondHtml = await secondDecision.text();
    expect(secondHtml).not.toContain("Approved</h1>");

    const rowAfter = await approvalRow(approval_id);
    expect(rowAfter?.declined_at).not.toBeNull();
    expect(rowAfter?.granted_at).toBeNull();
  });

  test("an unidentified POST is refused — no approval is recorded to nobody", async () => {
    const { approval_id, approval_url } = await seedApproval();
    const grant = grantParam(approval_url);

    const res = await decide(grant, "approve", { authenticated: false, csrf: "" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Sign in");

    const row = await approvalRow(approval_id);
    expect(row?.granted_at).toBeNull();
  });

  test("a signed-in approver without a valid CSRF token is refused", async () => {
    const { approval_id, approval_url } = await seedApproval();
    const grant = grantParam(approval_url);

    const res = await decide(grant, "approve", { csrf: "not-a-signed-token" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("verify");

    const row = await approvalRow(approval_id);
    expect(row?.granted_at).toBeNull();
  });

  test("a CSRF token minted for one approval cannot decide another", async () => {
    const first = await seedApproval();
    const second = await seedApproval();
    const firstGrant = grantParam(first.approval_url);
    const secondGrant = grantParam(second.approval_url);

    const page = await fetch(
      `${server.baseUrl}/v1/tool-approvals/decide?grant=${encodeURIComponent(firstGrant)}`,
      { headers: { cookie: browserCookie } },
    );
    const stolen = /name="csrf_token" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";

    const res = await decide(secondGrant, "approve", { csrf: stolen });
    expect(res.status).toBe(400);
    expect(await approvalRow(second.approval_id).then((r) => r?.granted_at)).toBeNull();
  });

  test("a forged/expired token on POST is rejected and grants nothing", async () => {
    const { approval_id, approval_url } = await seedApproval();
    await server.db
      .update(toolApprovals)
      .set({ expires_at: ONE_SECOND_AGO })
      .where(eq(toolApprovals.id, approval_id));
    const grant = grantParam(approval_url);

    const res = await decide(grant, "approve");
    expect(res.status).toBe(400);

    const row = await approvalRow(approval_id);
    expect(row?.granted_at).toBeNull();

    const forgedRes = await decide("skag_forged-token-that-names-nothing-0000", "approve");
    expect(forgedRes.status).toBe(400);
  });

  test("missing grant or invalid decision → 400, nothing changed", async () => {
    const res = await fetch(`${server.baseUrl}/v1/tool-approvals/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ decision: "approve" }).toString(),
    });
    expect(res.status).toBe(400);

    const { approval_url } = await seedApproval();
    const grant = grantParam(approval_url);
    const badDecision = await fetch(`${server.baseUrl}/v1/tool-approvals/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant, decision: "maybe" }).toString(),
    });
    expect(badDecision.status).toBe(400);
  });
});
