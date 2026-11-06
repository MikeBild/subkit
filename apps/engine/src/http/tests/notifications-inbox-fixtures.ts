import { afterAll, beforeAll, expect } from "bun:test";
import { createHash } from "node:crypto";
import { apiKeys, auditLog, cliNotificationInbox, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

export let srv: HttpTestServer;

export let tenantBKey: string;

export let enduserKey: string;

export let colleagueKey: string;

export let systemAccountKey: string;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

let keySeq = 0;

function genKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = `${String(++keySeq).padStart(4, "0")}skcliinboxtestkeypadding`.slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

export async function insertInboxRow(
  tenantId: string,
  opts: { event_type?: string; severity?: string; actionable?: boolean } = {},
): Promise<number> {
  const [row] = await srv.db
    .insert(cliNotificationInbox)
    .values({
      tenant_id: tenantId,
      severity: opts.severity ?? "info",
      event_type: opts.event_type ?? "test.event",
      event_payload: { test: true },
      actionable: opts.actionable ?? false,
    })
    .returning({ id: cliNotificationInbox.id });
  if (!row) throw new Error("inbox row insert failed");
  return row.id;
}

interface InboxItem {
  id: number;
  severity: string;
  event_type: string;
  actionable: boolean;
  resource_type: string | null;
  resource_id: string | null;
  read: boolean;
  read_at: string | null;
}

interface InboxList {
  items: InboxItem[];
  cursor: number;
  unread_count: number;
  actionable_unread_count: number;
}

export async function listInbox(query: string, token?: string): Promise<InboxList> {
  const res = await apiFetch(`/v1/notifications/inbox${query}`, {}, token);
  expect(res.status).toBe(200);
  return (await res.json()) as InboxList;
}

export function ack(upToCursor: number, token?: string): Promise<Response> {
  return apiFetch(
    "/v1/notifications/inbox/ack",
    { method: "POST", body: JSON.stringify({ up_to_cursor: upToCursor }) },
    token,
  );
}

export function apiFetch(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token ?? srv.apiKey}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${srv.baseUrl}${path}`, { ...init, headers });
}

export async function clearInbox(): Promise<void> {
  await srv.db.delete(cliNotificationInbox);
  await srv.db.delete(auditLog);
}

export function setupNotificationsInbox(): void {
  keySeq = 0;
  beforeAll(async () => {
    srv = await createHttpTestServer("notifications-inbox");

    const tB = await seedTenant(srv.db, { slug: "ninbox-b", display_name: "Ninbox B" });

    const [uB] = await srv.db
      .insert(users)
      .values({
        tenant_id: tB.id,
        email: "admin@ninbox-b.local",
        role_id: await builtinRoleId(srv.db, "admin"),
      })
      .returning();
    if (!uB) throw new Error("seed user B failed");
    const kB = genKey();
    await srv.db.insert(apiKeys).values({
      tenant_id: tB.id,
      user_id: uB.id,
      prefix: kB.prefix,
      token_sha256: kB.hash,
      scopes: ["*"],
    });
    tenantBKey = kB.plaintext;

    const [uE] = await srv.db
      .insert(users)
      .values({
        tenant_id: srv.tenantId,
        email: "enduser@ninbox-a.local",
        role_id: await builtinRoleId(srv.db, "enduser"),
      })
      .returning();
    if (!uE) throw new Error("seed enduser failed");
    const kE = genKey();
    await srv.db.insert(apiKeys).values({
      tenant_id: srv.tenantId,
      user_id: uE.id,
      prefix: kE.prefix,
      token_sha256: kE.hash,
      scopes: ["*"],
    });
    enduserKey = kE.plaintext;

    const [uC] = await srv.db
      .insert(users)
      .values({
        tenant_id: srv.tenantId,
        email: "colleague@ninbox-a.local",
        role_id: await builtinRoleId(srv.db, "admin"),
      })
      .returning();
    if (!uC) throw new Error("seed colleague failed");
    const kC = genKey();
    await srv.db.insert(apiKeys).values({
      tenant_id: srv.tenantId,
      user_id: uC.id,
      prefix: kC.prefix,
      token_sha256: kC.hash,
      scopes: ["*"],
    });
    colleagueKey = kC.plaintext;

    const kS = genKey();
    await srv.db.insert(apiKeys).values({
      tenant_id: srv.tenantId,
      system_account_id: srv.systemAccountId,
      prefix: kS.prefix,
      token_sha256: kS.hash,
      scopes: ["*"],
    });
    systemAccountKey = kS.plaintext;
  }, 60_000);
  afterAll(async () => {
    await srv.cleanup();
  }, 30_000);
}
