import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { browserSessionFromRequest } from "../../auth/browser-session.ts";
import { auditLog, sessions, toolApprovals } from "../../db/schema/index.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import {
  approvalRow,
  browserCookie,
  decide,
  grantParam,
  ONE_SECOND_AGO,
  requester,
  seedApproval,
  server,
  setupToolApprovals,
  signIn,
} from "../tests/tool-approvals-fixtures.ts";

setupToolApprovals();

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
