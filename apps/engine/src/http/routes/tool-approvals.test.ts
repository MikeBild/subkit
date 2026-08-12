// Integration tests for the approval portal — the out-of-band channel a
// HUMAN uses to grant or decline a tool approval:
//   GET  /v1/tool-approvals/decide?grant=skag_…  — UNAUTHENTICATED, resolves
//        the grant WITHOUT consuming it, and renders exactly what will be
//        written (`would_write`) — never the decrypted args, never the
//        ciphertext.
//   POST /v1/tool-approvals/decide               — UNAUTHENTICATED (grant-
//        token auth). Grants or declines through the approval's own atomic
//        CAS — single-use, terminal on decline.
//
// Mirrors the precedent shape from
// http/routes/connectors/credentials-setup.test.ts, adapted for the
// approval-decision (not credential-write) contract.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { issueBrowserSession } from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { setConfigKey } from "../../config/loader.ts";
import { auditLog, toolApprovals } from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { requestApproval } from "../../tools/approval.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

// Deterministic approval ids — the determinism gate forbids crypto.randomUUID()
// in tests. A fixed past instant for the expiry-forcing updates below.
const nextApprovalId = createDeterministicUuidFactory(0x70724c);
const ONE_SECOND_AGO = new Date(1_699_999_999_000);

let server: HttpTestServer;
let requester: ResolvedPrincipal;

// A secret that lives ONLY in the domain args, never in the would_write
// preview — proves the portal page never renders decrypted args.
const SECRET_ARG_VALUE = "TOTALLY-SECRET-ARG-VALUE-4f9c1e";

beforeAll(async () => {
  server = await createHttpTestServer("tool-approvals-portal");
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
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

/** Open an approval and return its portal `approval_url`. */
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
  test("renders would_write, and never the decrypted args or the ciphertext", async () => {
    const { approval_id, approval_url } = await seedApproval();

    // The preview is shown to a signed-in approver: the page names who is about
    // to release the write, so it needs to know who that is.
    const res = await fetch(approval_url, {
      headers: { authorization: `Bearer ${server.apiKey}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    // The write preview IS rendered.
    expect(html).toContain("post_ledger");
    expect(html).toContain("POST");
    expect(html).toContain("ledger.example.test/entries");

    // The decrypted domain args are NEVER rendered — the secret lives only
    // in `args_ciphertext`, not in the preview.
    expect(html).not.toContain(SECRET_ARG_VALUE);

    // Neither is the ciphertext itself, in any encoding.
    const row = await approvalRow(approval_id);
    expect(row).not.toBeNull();
    const cipherB64 = Buffer.from(row!.args_ciphertext).toString("base64");
    const cipherHex = Buffer.from(row!.args_ciphertext).toString("hex");
    expect(html).not.toContain(cipherB64);
    expect(html.toLowerCase()).not.toContain(cipherHex.slice(0, 24));

    // The GET does not consume — the row is still pending.
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
    // Grant possession scopes WHICH approval is on the table; it is not an
    // identity. Until this held, `granted_by_user_id` was NULL on every grant in
    // production and anyone holding a forwarded link could release a write.
    const { approval_url } = await seedApproval();

    const res = await fetch(approval_url, { redirect: "manual" });
    expect([302, 200]).toContain(res.status);
    const body = res.status === 302 ? (res.headers.get("location") ?? "") : await res.text();
    expect(body).toContain("/v1/identity/login/start");
    // Nothing about the pending write leaks to an anonymous visitor.
    expect(body).not.toContain("post_ledger");
    expect(body).not.toContain(SECRET_ARG_VALUE);
  });

  test("GET without a grant param → 400 (Zod validation)", async () => {
    const res = await fetch(`${server.baseUrl}/v1/tool-approvals/decide`);
    expect(res.status).toBe(400);
  });
});

/** The real decision flow: open the page as the signed-in approver, take the
 *  CSRF token that page minted, then submit it back.
 *
 *  Grant possession alone no longer decides. It scopes WHICH approval is on the
 *  table; WHO decides comes from a signed-in account, because
 *  `granted_by_user_id` used to be NULL on every grant in production and an
 *  unattributable authorization is exactly what an audited system must refuse. */
async function decide(
  grant: string,
  decision: "approve" | "decline",
  opts: { authenticated?: boolean; csrf?: string } = {},
): Promise<Response> {
  const authenticated = opts.authenticated ?? true;
  const headers: Record<string, string> = authenticated
    ? { authorization: `Bearer ${server.apiKey}` }
    : {};
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
  test("approve grants once, and the token dies — a second decision on the same token is refused", async () => {
    const { approval_id, approval_url } = await seedApproval();
    const grant = grantParam(approval_url);

    const res = await decide(grant, "approve");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Approved");

    const row = await approvalRow(approval_id);
    expect(row?.granted_at).not.toBeNull();
    // The requesting principal never appears as the approver.
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

    // The token is dead: a second POST (with the same grant token) is refused
    // and changes nothing.
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

    // A second decision (approve, this time) against the same token cannot
    // undo the decline.
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
    // A cross-site form post must not be able to release a write on behalf of an
    // approver who merely happens to be signed in.
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
      { headers: { authorization: `Bearer ${server.apiKey}` } },
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
