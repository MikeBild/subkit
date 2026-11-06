import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { issueBrowserSession } from "../../auth/browser-session.ts";
import { auditLog, connectors, toolApprovals } from "../../db/schema/index.ts";
import {
  approvalRow,
  browserCookie,
  expectPortalActors,
  grantParam,
  nextApprovalId,
  ONE_SECOND_AGO,
  SECRET_ARG_VALUE,
  seedApproval,
  server,
  setupToolApprovals,
} from "../tests/tool-approvals-fixtures.ts";

setupToolApprovals();

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
