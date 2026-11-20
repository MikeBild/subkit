import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { ToolContext } from "../../../conversations/tools/index.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../../../http/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { defaultTaskServiceDeps, type TaskCreateInput } from "../../../tasks/index.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { makeToolCtx } from "../../../test-helpers/seed.ts";

export const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

export interface TaskPerson {
  readonly id: string;
  readonly key: string;
  readonly principal: ResolvedPrincipal;
}

export interface TaskWorld {
  readonly ctx: HttpTestServer;
  readonly owner: TaskPerson;
  readonly other: TaskPerson;
  readonly admin: TaskPerson;
  readonly enduser: TaskPerson;
  readonly denied: TaskPerson;
  readonly enqueued: string[];
  readonly actual: Record<string, string>;
  record(name: string, value: unknown): void;
  http(
    method: string,
    path: string,
    body?: unknown,
    key?: string | Record<string, string>,
  ): Promise<{ status: number; body: unknown }>;
  browser(person: TaskPerson): Promise<Record<string, string>>;
  toolCtx(person: TaskPerson | null, overrides?: Partial<ToolContext>): ToolContext;
  auditTrail(resource_id: string): Promise<unknown[]>;
  staleKeys(): { actual: string[]; golden: string[] };
  cleanup(): Promise<void>;
}

export function taskBody(overrides: Partial<TaskCreateInput> = {}): TaskCreateInput {
  return {
    name: "Weekly report",
    description: null,
    goal: "Send the weekly report",
    done_when: "The report is in the inbox",
    plan: {
      title: "Weekly report",
      goal: "Send the weekly report",
      steps: [
        {
          id: "collect",
          label: "Collect the numbers",
          criterion: { kind: "assessment", description: "Numbers are complete", result: null },
          depends_on: [],
          evidence_ids: [],
          note: null,
          progress: "open",
          next_action: null,
        },
      ],
      cancelled: false,
      completion_step_id: null,
    },
    bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
    environment: "dev",
    schedule_cron: null,
    schedule_timezone: null,
    schedule_run_at: null,
    max_turns: 20,
    run_deadline_minutes: 240,
    ...overrides,
  };
}

export async function createTaskWorld(label: string, goldenName: string): Promise<TaskWorld> {
  const ctx = await createHttpTestServer(label);
  const goldenPath = new URL(`./fixtures/${goldenName}.golden.json`, import.meta.url).pathname;
  const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Record<string, string>;
  const actual: Record<string, string> = {};
  const enqueued: string[] = [];
  const wired = defaultTaskServiceDeps.enqueueRunTurn;
  defaultTaskServiceDeps.enqueueRunTurn = async (_db, params) => {
    enqueued.push(params.task_run_id);
  };
  let seed = 0x7a_5c;

  async function person(name: string, role: string | null): Promise<TaskPerson> {
    const role_id = role
      ? await builtinRoleId(ctx.db, role)
      : await emptyRoleId(ctx.db, ctx.tenantId);
    const [user] = await ctx.db
      .insert(users)
      .values({ tenant_id: ctx.tenantId, email: `${name}@tasks-golden.test`, role_id })
      .returning();
    if (!user) throw new Error("user insert returned no row");
    seed += 1;
    const key = `wf_live_${createDeterministicHexFactory(seed)(16)}`;
    await ctx.testDb.pool.query(
      "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [
        ctx.tenantId,
        user.id,
        key.slice(0, 12),
        createHash("sha256").update(key).digest("hex"),
        JSON.stringify(["*"]),
      ],
    );
    return {
      id: user.id,
      key,
      principal: {
        provider: "session",
        kind: "user",
        id: user.id,
        tenant_id: ctx.tenantId,
        roles: role ? [role] : [],
      },
    };
  }

  const owner = await person("owner", "member");
  const other = await person("other", "member");
  const enduser = await person("enduser", "enduser");
  const denied = await person("denied", null);
  const admin: TaskPerson = {
    id: ctx.userId,
    key: ctx.apiKey,
    principal: {
      provider: "session",
      kind: "user",
      id: ctx.userId,
      tenant_id: ctx.tenantId,
      roles: ["admin"],
    },
  };
  const people: Array<[string, string]> = [
    [owner.id, "<owner>"],
    [other.id, "<other>"],
    [enduser.id, "<enduser>"],
    [denied.id, "<denied>"],
    [admin.id, "<admin>"],
  ];

  function normalize(value: unknown): string {
    let text = JSON.stringify(value).replaceAll(ctx.tenantId, "<tenant>");
    for (const [id, name] of people) text = text.replaceAll(id, name);
    return text
      .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
      .replace(/"trace_id":"[^"]*"/g, '"trace_id":"<trace>"')
      .replace(/"request_id":"[^"]*"/g, '"request_id":"<request>"')
      .replace(/"audit_trace_id":"[^"]*"/g, '"audit_trace_id":"<trace>"')
      .replace(/"fingerprint":"[0-9a-f]{64}"/g, '"fingerprint":"<fingerprint>"')
      .replace(/"duration_ms":\d+/g, '"duration_ms":"<ms>"')
      .replace(
        /\b(?!5eed|0f0f0f0f)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
        "<uuid>",
      );
  }

  return {
    ctx,
    owner,
    other,
    admin,
    enduser,
    denied,
    enqueued,
    actual,
    record(name, value) {
      actual[name] = normalize(value);
      expect(actual[name]).toBe(golden[name] as string);
    },
    async http(method, path, body, key = owner.key) {
      const headers =
        typeof key === "string"
          ? { authorization: `Bearer ${key}`, "content-type": "application/json" }
          : key;
      const res = await fetch(`${ctx.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    browser: (who) => browserSessionHeaders({ db: ctx.db, tenantId: ctx.tenantId }, who.id),
    toolCtx(who, overrides = {}) {
      return makeToolCtx({
        db: ctx.db,
        tenant_id: ctx.tenantId,
        ...(who ? { actor_id: who.id, principal: who.principal } : {}),
        ...overrides,
      });
    },
    async auditTrail(resource_id) {
      return ctx.db
        .select({
          action: auditLog.action,
          actor_type: auditLog.actor_type,
          actor_id: auditLog.actor_id,
          resource_type: auditLog.resource_type,
          result: auditLog.result,
          reason: auditLog.reason,
          metadata: auditLog.metadata,
        })
        .from(auditLog)
        .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, resource_id)))
        .orderBy(asc(auditLog.ts), asc(auditLog.action));
    },
    staleKeys: () => ({
      actual: Object.keys(actual).sort(),
      golden: Object.keys(golden).sort(),
    }),
    async cleanup() {
      defaultTaskServiceDeps.enqueueRunTurn = wired;
      await ctx.cleanup();
    },
  };
}
