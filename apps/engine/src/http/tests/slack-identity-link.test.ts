import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { issueBrowserSession } from "../../auth/browser-session.ts";
import { signSlackLinkToken } from "../../chat/index.ts";
import { setConfigKey } from "../../config/loader.ts";
import { auditLog, chatIdentities, chatWorkspaces } from "../../db/schema/index.ts";
import { SLACK_DECISION_COPY } from "../i18n/slack-decisions.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const TEAM = "T_LINK";
let server: HttpTestServer;
let cookie = "";

async function linkToken(slack_user_id: string, tenant_id = server.tenantId): Promise<string> {
  return await signSlackLinkToken({ tenant_id, team_id: TEAM, slack_user_id });
}

function open(token: string, withCookie = true): Promise<Response> {
  return fetch(`${server.baseUrl}/v1/integrations/slack/link?token=${encodeURIComponent(token)}`, {
    headers: { ...(withCookie ? { cookie } : {}), "accept-language": "en" },
    redirect: "manual",
  });
}

async function confirm(token: string, csrf?: string): Promise<Response> {
  const page = await open(token);
  const csrf_token = csrf ?? /name="csrf_token" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  return await fetch(`${server.baseUrl}/v1/integrations/slack/link`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      "accept-language": "en",
    },
    body: new URLSearchParams({ token, csrf_token }).toString(),
  });
}

async function linkedRows(slack_user_id: string) {
  return server.db
    .select()
    .from(chatIdentities)
    .where(
      and(
        eq(chatIdentities.tenant_id, server.tenantId),
        eq(chatIdentities.platform_user_id, slack_user_id),
      ),
    );
}

beforeAll(async () => {
  server = await createHttpTestServer("slack-identity-link");
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
  const login = await issueBrowserSession({
    db: server.db,
    tenantId: server.tenantId,
    userId: server.userId,
    redirectTo: server.baseUrl,
    via: "slack_link_test",
  });
  cookie = login.headers.get("set-cookie") ?? "";
  await server.db.insert(chatWorkspaces).values({
    tenant_id: server.tenantId,
    platform: "slack",
    workspace_id: TEAM,
    bot_ciphertext: Buffer.alloc(8, 1),
    bot_iv: Buffer.alloc(8, 2),
    bot_auth_tag: Buffer.alloc(8, 3),
  });
});

afterAll(async () => {
  await server.cleanup();
});

describe("one-time Slack account link", () => {
  test("without a session the page sends the person to sign in and back", async () => {
    const response = await open(await linkToken("U_A"), false);
    expect(response.status).toBe(302);
    expect(response.headers.get("location") ?? "").toContain("/v1/identity/login/start");
  });

  test("an invalid link shows the expired page", async () => {
    const response = await open("not-a-token");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(SLACK_DECISION_COPY.en.page.deadTitle);
  });

  test("the signed-in person confirms and the Slack account is linked once, audited as self", async () => {
    const token = await linkToken("U_A");
    const page = await open(token);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("U_A");

    const linked = await confirm(token);
    expect(linked.status).toBe(200);
    expect(await linked.text()).toContain(SLACK_DECISION_COPY.en.page.linkedTitle);
    const rows = await linkedRows("U_A");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(server.userId);

    const [entry] = await server.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, server.tenantId), eq(auditLog.action, "chat_identity.linked")),
      );
    expect(entry?.actor_id).toBe(server.userId);
    expect(entry?.metadata).toMatchObject({
      kind: "self",
      platform: "slack",
      platform_user_id: "U_A",
    });

    const again = await confirm(token);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain(SLACK_DECISION_COPY.en.page.alreadyTitle);
  });

  test("a confirmation without the page's CSRF token links nothing", async () => {
    const response = await confirm(await linkToken("U_B"), "forged");
    expect(response.status).toBe(400);
    expect(await linkedRows("U_B")).toHaveLength(0);
  });
});
