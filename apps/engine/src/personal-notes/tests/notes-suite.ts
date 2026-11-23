import { afterAll, beforeAll } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { conversationMessages, conversations, users } from "../../db/schema/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../../http/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";

export const AT = new Date("2026-11-20T09:00:00.000Z");

export interface NotesSuite {
  ctx: HttpTestServer;
  adminHeaders: Record<string, string>;
  memberHeaders: Record<string, string>;
  memberId: string;
  conversationId: string;
}

export function setupNotesSuite(label: string): NotesSuite {
  const suite = {} as NotesSuite;
  beforeAll(async () => {
    suite.ctx = await createHttpTestServer(label);
    const [member] = await suite.ctx.db
      .insert(users)
      .values({
        tenant_id: suite.ctx.tenantId,
        email: `member-${label}@test.local`,
        role_id: await builtinRoleId(suite.ctx.db, "member"),
      })
      .returning();
    if (!member) throw new Error("missing member fixture");
    suite.memberId = member.id;
    suite.adminHeaders = await browserSessionHeaders(suite.ctx, suite.ctx.userId);
    suite.memberHeaders = await browserSessionHeaders(suite.ctx, member.id);
    suite.conversationId = await addConversation(suite, member.id);
  });
  afterAll(async () => {
    await suite.ctx?.cleanup();
  });
  return suite;
}

export function ownerOf(suite: NotesSuite, user_id: string) {
  return { tenant_id: suite.ctx.tenantId, user_id };
}

export function principalOf(
  suite: NotesSuite,
  user_id: string,
  kind: "browser_session" | "task_run",
): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: user_id,
    tenant_id: suite.ctx.tenantId,
    roles: [],
    auth_source:
      kind === "browser_session"
        ? { kind, session_id: "s1" }
        : { kind, task_id: "t1", task_run_id: "r1", grant_id: null },
  };
}

export async function addMessage(
  suite: NotesSuite,
  conversation_id: string,
  role: "user" | "assistant",
  content: Record<string, unknown>,
  created_at: Date,
): Promise<string> {
  const [row] = await suite.ctx.db
    .insert(conversationMessages)
    .values({ tenant_id: suite.ctx.tenantId, conversation_id, role, content, created_at })
    .returning({ id: conversationMessages.id });
  if (!row) throw new Error("missing message fixture");
  return row.id;
}

export async function addConversation(suite: NotesSuite, owner_id: string): Promise<string> {
  const [row] = await suite.ctx.db
    .insert(conversations)
    .values({ tenant_id: suite.ctx.tenantId, status: "active", owner_id, surface: "web" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("missing conversation fixture");
  return row.id;
}

export async function callNotes(
  suite: NotesSuite,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  const response = await fetch(`${suite.ctx.baseUrl}/v1/identity/me/notes${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
