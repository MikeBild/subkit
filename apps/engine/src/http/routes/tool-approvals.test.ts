import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { browserSessionFromRequest, issueBrowserSession } from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { setConfigKey } from "../../config/loader.ts";
import { auditLog, sessions, toolApprovals } from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
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
      expect(html).toContain(locale === "de" ? "Handlungsgrenze" : "Decision boundary");
      expect(html).not.toContain("Nothing has run");
      expect(html).not.toContain("expires shortly");
      expect(html).not.toContain(approval_id);
      expect(html).not.toContain("<script");
      expect((await approvalRow(approval_id))?.granted_at).toBeNull();
    });
  }

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
      headers: { cookie: browserCookie },
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

    const row = await approvalRow(approval_id);
    expect(row).not.toBeNull();
    const cipherB64 = Buffer.from(row!.args_ciphertext).toString("base64");
    const cipherHex = Buffer.from(row!.args_ciphertext).toString("hex");
    expect(html).not.toContain(cipherB64);
    expect(html.toLowerCase()).not.toContain(cipherHex.slice(0, 24));

    expect(row?.granted_at).toBeNull();
    expect(row?.declined_at).toBeNull();
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
    expect(html).toContain("Approved");

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
