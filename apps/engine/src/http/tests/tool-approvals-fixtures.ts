import { afterAll, beforeAll, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { issueBrowserSession } from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { setConfigKey } from "../../config/loader.ts";
import { toolApprovals } from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { requestApproval } from "../../tools/approval.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

export let nextApprovalId = createDeterministicUuidFactory(0x70724c);

export const ONE_SECOND_AGO = new Date(1_699_999_999_000);

export let server: HttpTestServer;

export let requester: ResolvedPrincipal;

export let browserCookie: string;

export async function signIn(): Promise<string> {
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

export const SECRET_ARG_VALUE = "TOTALLY-SECRET-ARG-VALUE-4f9c1e";

export async function seedApproval(opts?: {
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

export function grantParam(url: string): string {
  return new URL(url).searchParams.get("grant") ?? "";
}

export function expectPortalActors(html: string, locale: "de" | "en"): void {
  expect(html).toContain(locale === "de" ? "<dt>Angefragt von</dt>" : "<dt>Requested by</dt>");
  expect(html).toContain(
    locale === "de"
      ? "<dd>bot-tool-approvals-portal · Systemkonto</dd>"
      : "<dd>bot-tool-approvals-portal · System account</dd>",
  );
  expect(html).toContain(locale === "de" ? "<dt>Entscheidet</dt>" : "<dt>Deciding person</dt>");
  expect(html).toContain("<dd>admin-tool-approvals-portal@test.local</dd>");
}

export async function approvalRow(approval_id: string) {
  const rows = await server.db
    .select()
    .from(toolApprovals)
    .where(eq(toolApprovals.id, approval_id));
  return rows[0] ?? null;
}

export async function decide(
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

export function setupToolApprovals(): void {
  nextApprovalId = createDeterministicUuidFactory(0x70724c);
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
}
