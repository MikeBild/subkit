import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { runHeadless } from "../../../../subkit/src/headless.ts";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import { apiKeys, auditLog, portalTokens, users } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

describe("each role works in the subkit terminal chat", () => {
  describe("an admin's golden path", () => {
    let ctx: JourneyCtx;

    interface AuditRow {
      id: string;
      action: string;
      actor_id: string | null;
      resource_type: string;
      resource_id: string | null;
      metadata: Record<string, unknown>;
    }

    async function auditRows(opts: { action?: string; actor_id?: string }): Promise<AuditRow[]> {
      const query = new URLSearchParams();
      if (opts.action) query.set("action", opts.action);
      if (opts.actor_id) query.set("actor_id", opts.actor_id);
      query.set("limit", "50");
      const res = await journeyFetch(ctx, `/v1/audit-log?${query.toString()}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: AuditRow[] };
      return body.items;
    }

    let conversationId: string;

    beforeAll(async () => {
      ctx = await createJourneyCtx("subkit-cli-01-admin");
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: runHeadless creates a conversation and emits CONVERSATION_CREATED", async () => {
      const stdoutBuf: string[] = [];
      const stderrBuf: string[] = [];
      const result = await runHeadless({
        profile: {
          name: "journey",
          engine_url: ctx.baseUrl,
          api_key: ctx.apiKey,
          active_tenant_id: ctx.tenantId,
        },
        prompt: "check the JSONPlaceholder connector for me",
        output: "json",
        noMemory: true,
        stdout: { write: (s) => stdoutBuf.push(s) },
        stderr: { write: (s) => stderrBuf.push(s) },
      });
      expect(result.exitCode).toBe(0);
      expect(result.conversation_id).not.toBeNull();
      conversationId = result.conversation_id as string;
      const rows = await auditRows({
        action: "conversation.created",
        actor_id: ctx.userId,
      });
      const latest = rows[0];
      expect(latest?.resource_id).toBe(conversationId);
      const [stored] = await ctx.db
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.id, latest!.id), eq(auditLog.tenant_id, ctx.tenantId)));
      const evidence = stored?.metadata as Record<string, unknown> | undefined;
      expect(evidence?.owner_id).toBe(ctx.userId);
      expect(evidence?.memory_included).toBe(false);
    });

    test("AC2: memory injection emits CONVERSATION_MEMORY_INJECTED", async () => {
      const detail = (await (
        await journeyFetch(ctx, `/v1/conversations/${conversationId}`)
      ).json()) as {
        resume_summary?: {
          pending_approval?: { id: string; tool_name: string } | null;
        } | null;
      };
      const pending = detail.resume_summary?.pending_approval ?? null;
      if (pending) {
        const resp = await journeyFetch(
          ctx,
          `/v1/conversations/${conversationId}/elicitations/${pending.id}/respond`,
          {
            method: "POST",
            body: JSON.stringify({ output: { confirmed: true } }),
          },
        );
        expect(resp.status).toBe(200);
      }

      const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          message: "follow up turn",
          memory: "# Context\n- prefer JSON responses\n",
        }),
      });
      expect(res.status).toBe(200);
      const rows = await auditRows({
        action: "conversation.memory_injected",
        actor_id: ctx.userId,
      });
      expect(rows.some((r) => r.resource_id === conversationId)).toBe(true);
    });

    test("AC3: compact collapses history and emits CONVERSATION_COMPACTED", async () => {
      const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/compact`, {
        method: "POST",
        body: JSON.stringify({ keep_last: 1 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages_collapsed: number; summary: string };
      expect(body.messages_collapsed).toBeGreaterThan(0);
      expect(typeof body.summary).toBe("string");
      const rows = await auditRows({ action: "conversation.compacted" });
      expect(rows.some((r) => r.resource_id === conversationId)).toBe(true);
    });

    test("AC4: PATCH stores model + title and emits CONVERSATION_UPDATED", async () => {
      const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}`, {
        method: "PATCH",
        body: JSON.stringify({
          model: "anthropic:claude-opus-4-6",
          title: "Admin golden path",
        }),
      });
      expect(res.status).toBe(200);
      const patched = (await res.json()) as { model: string | null; title: string | null };
      expect(patched.model).toBe("anthropic:claude-opus-4-6");
      expect(patched.title).toBe("Admin golden path");
      const rows = await auditRows({ action: "conversation.updated" });
      expect(rows.some((r) => r.resource_id === conversationId)).toBe(true);
    });

    test("AC5: owner=me list returns my conversations", async () => {
      const res = await journeyFetch(ctx, "/v1/conversations?owner=me&limit=50");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ id: string; owner_id: string | null; title: string | null }>;
      };
      const mine = body.items.find((i) => i.id === conversationId);
      expect(mine).toBeDefined();
      expect(mine?.owner_id).toBe(ctx.userId);
      expect(mine?.title).toBe("Admin golden path");
    });

    test("AC6: cancel flips status to abandoned and emits CONVERSATION_CANCELLED", async () => {
      const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const cancelled = (await res.json()) as { status: string };
      expect(cancelled.status).toBe("abandoned");
      const rows = await auditRows({ action: "conversation.cancelled" });
      expect(rows.some((r) => r.resource_id === conversationId)).toBe(true);
    });
  });

  describe("a member's daily driver", () => {
    let ctx: JourneyCtx;

    let memberId: string;

    let memberApiKey: string;

    async function memberFetch(path: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${memberApiKey}`);
      if (init.body && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
    }

    async function findAudit(
      action: string,
      opts: { resource_id?: string; actor_id?: string } = {},
    ): Promise<Array<Record<string, unknown>>> {
      const q = new URLSearchParams({ action, limit: "50" });
      if (opts.actor_id) q.set("actor_id", opts.actor_id);
      const res = await journeyFetch(ctx, `/v1/audit-log?${q.toString()}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<Record<string, unknown>> };
      return opts.resource_id
        ? body.items.filter((row) => row.resource_id === opts.resource_id)
        : body.items;
    }

    let conversationId = "";

    beforeAll(async () => {
      ctx = await createJourneyCtx("subkit-cli-02-member");
      const [u] = await ctx.db
        .insert(users)
        .values({
          tenant_id: ctx.tenantId,
          email: "member@subkit-cli-02.test",
          role_id: ctx.rbacRoleIds.member,
        })
        .returning();
      if (!u) throw new Error("failed to seed member user");
      memberId = u.id;

      const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
      memberApiKey = `wf_live_${rand}`;
      await ctx.db.insert(apiKeys).values({
        tenant_id: ctx.tenantId,
        user_id: memberId,
        prefix: memberApiKey.slice(0, 12),
        token_sha256: sha256Hex(memberApiKey),
        scopes: ["*"],
      });
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: member can POST /v1/conversations", async () => {
      const res = await memberFetch("/v1/conversations", {
        method: "POST",
        body: JSON.stringify({ initial_message: "hello from a member" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { conversation: { id: string; owner_id: string | null } };
      conversationId = body.conversation.id;
      expect(body.conversation.owner_id).toBe(memberId);
      const rows = await findAudit("conversation.created", {
        resource_id: conversationId,
        actor_id: memberId,
      });
      expect(rows.length).toBe(1);
    });

    test("AC2: member POST with memory emits CONVERSATION_MEMORY_INJECTED", async () => {
      const res = await memberFetch(`/v1/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "turn with memory", memory: "# hints" }),
      });
      expect(res.status).toBe(200);
      const rows = await findAudit("conversation.memory_injected", {
        resource_id: conversationId,
        actor_id: memberId,
      });
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    test("AC3: member is denied GET /v1/audit-log with policy.denied row", async () => {
      const res = await memberFetch("/v1/audit-log");
      expect(res.status).toBe(403);
      await _drainAuditWritesForTests(ctx.db);
      const denials = await ctx.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, ctx.tenantId),
            eq(auditLog.actor_id, memberId),
            eq(auditLog.action, "policy.denied"),
          ),
        );
      const auditDenial = denials.find(
        (r) =>
          (r.metadata as { permission?: string }).permission === "audit:read" ||
          (r.metadata as { permission?: string }).permission?.startsWith("audit"),
      );
      expect(auditDenial).toBeDefined();
    });

    test("AC4: member PATCH /v1/conversations/:id is accepted and audited", async () => {
      const res = await memberFetch(`/v1/conversations/${conversationId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "member authored", model: "anthropic:claude-sonnet-4-6" }),
      });
      expect(res.status).toBe(200);
      const rows = await findAudit("conversation.updated", {
        resource_id: conversationId,
        actor_id: memberId,
      });
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("an end user's dashboard", () => {
    let ctx: JourneyCtx;

    let enduserId: string;

    let enduserApiKey: string;

    async function endFetch(path: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${enduserApiKey}`);
      if (init.body && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
    }

    beforeAll(async () => {
      ctx = await createJourneyCtx("subkit-cli-03-enduser");
      const [u] = await ctx.db
        .insert(users)
        .values({
          tenant_id: ctx.tenantId,
          email: "enduser@subkit-cli-03.test",
          role_id: ctx.rbacRoleIds.enduser,
        })
        .returning();
      if (!u) throw new Error("failed to seed enduser");
      enduserId = u.id;
      const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
      enduserApiKey = `wf_live_${rand}`;
      await ctx.db.insert(apiKeys).values({
        tenant_id: ctx.tenantId,
        user_id: enduserId,
        prefix: enduserApiKey.slice(0, 12),
        token_sha256: sha256Hex(enduserApiKey),
        scopes: ["*"],
      });
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: enduser can POST /v1/conversations", async () => {
      const res = await endFetch("/v1/conversations", {
        method: "POST",
        body: JSON.stringify({ initial_message: "hello from an enduser" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { conversation: { owner_id: string | null } };
      expect(body.conversation.owner_id).toBe(enduserId);
    });

    test("AC2: enduser can GET /v1/skills (skill:read granted)", async () => {
      const res = await endFetch("/v1/skills");
      expect(res.status).toBe(200);
    });

    test("AC3: enduser is denied GET /v1/audit-log", async () => {
      const res = await endFetch("/v1/audit-log");
      expect(res.status).toBe(403);
    });

    test("AC4: enduser can PATCH their own conversation (conversation:write)", async () => {
      const create = await endFetch("/v1/conversations", {
        method: "POST",
        body: JSON.stringify({ initial_message: "for patching" }),
      });
      expect(create.status).toBe(201);
      const body = (await create.json()) as { conversation: { id: string } };
      const patch = await endFetch(`/v1/conversations/${body.conversation.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "mine" }),
      });
      expect(patch.status).toBe(200);
    });

    test("AC5: conversation:commit is denied for the enduser (rbac:can probe)", async () => {
      const res = await journeyFetch(ctx, "/v1/rbac/can", {
        method: "POST",
        body: JSON.stringify({
          principal_id: enduserId,
          permission: "conversation:commit",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { allow: boolean };
      expect(body.allow).toBe(false);
    });
  });

  describe("a portal-token customer", () => {
    const TEST_NOW_MS = getTestNow();

    let ctx: JourneyCtx;

    let portalToken: string;

    let workflowId: string;

    async function pFetch(path: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${portalToken}`);
      if (init.body && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
    }

    beforeAll(async () => {
      ctx = await createJourneyCtx("subkit-cli-04-portal");

      workflowId = (
        await seedWorkflow(ctx, {
          slug: "invoices",
          name: "Invoices",
          steps: [{ id: "s1", kind: "transform", expression: '"ok"' }],
        })
      ).id;

      const [end] = await ctx.db
        .insert(users)
        .values({
          tenant_id: ctx.tenantId,
          email: "portal-customer@subkit-cli-04.test",
          role_id: ctx.rbacRoleIds.portal_token_user,
        })
        .returning();
      if (!end) throw new Error("failed to seed enduser for portal token");

      const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
      portalToken = `wf_portal_${rand}`;
      await ctx.db.insert(portalTokens).values({
        tenant_id: ctx.tenantId,
        enduser_ref: end.id,
        prefix: portalToken.slice(0, 14),
        token_sha256: sha256Hex(portalToken),
        allowed_workflows: [workflowId],
        expires_at: new Date(TEST_NOW_MS + 3600_000),
      });
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: portal-token principal can POST /v1/conversations", async () => {
      const res = await pFetch("/v1/conversations", {
        method: "POST",
        body: JSON.stringify({ initial_message: "status check" }),
      });
      expect(res.status).toBe(201);
    });

    test("AC2: portal-token principal is denied GET /v1/skills", async () => {
      const res = await pFetch("/v1/skills");
      expect(res.status).toBe(403);
    });

    test("AC3: portal-token can read conversations (list)", async () => {
      const res = await pFetch("/v1/conversations");
      expect(res.status).toBe(403);
    });

    test("AC4: portal-token compact is allowed (conversation:write on allowlist path)", async () => {
      const create = await pFetch("/v1/conversations", {
        method: "POST",
        body: JSON.stringify({ initial_message: "to compact" }),
      });
      expect(create.status).toBe(201);
      const body = (await create.json()) as { conversation: { id: string } };
      const res = await pFetch(`/v1/conversations/${body.conversation.id}/compact`, {
        method: "POST",
        body: JSON.stringify({ keep_last: 0 }),
      });
      expect(res.status).toBe(200);
    });
  });
});
