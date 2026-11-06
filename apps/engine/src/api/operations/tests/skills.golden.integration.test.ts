import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq } from "drizzle-orm";
import { getSkillTool, listAllSkillsTool } from "../../../conversations/tools/engine-api/skills.ts";
import type { ToolContext } from "../../../conversations/tools/index.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createSkill } from "../../../skills/service.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { makeToolCtx, seedTenant } from "../../../test-helpers/seed.ts";

const GOLDEN_PATH = new URL("./fixtures/skills.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};

let ctx: HttpTestServer;
let deniedKey: string;
let alphaId: string;
let betaId: string;
let gammaId: string;
let foreignId: string;
let draftId: string;
let deltaId: string;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const REVIEWED = "Explains how the alpha skill is applied.";

function normalize(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"trace_id":"[^"]*"/g, '"trace_id":"<trace>"')
    .replace(/"request_id":"[^"]*"/g, '"request_id":"<request>"')
    .replace(/"audit_trace_id":"[^"]*"/g, '"audit_trace_id":"<trace>"')
    .replace(
      /\b(?!5eed|0f0f0f0f)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
      "<uuid>",
    );
}

function record(name: string, value: unknown): void {
  actual[name] = normalize(value);
  expect(actual[name]).toBe(golden[name] as string);
}

async function http(
  method: string,
  path: string,
  body?: unknown,
  key = ctx.apiKey,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function toolCtx(): ToolContext {
  return makeToolCtx({ db: ctx.db, tenant_id: ctx.tenantId });
}

async function auditTrail(resourceId: string) {
  return ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      resource_type: auditLog.resource_type,
      result: auditLog.result,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, resourceId)))
    .orderBy(asc(auditLog.ts), asc(auditLog.action));
}

async function deniedTrail() {
  return ctx.db
    .select({ action: auditLog.action, resource_type: auditLog.resource_type })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.result, "denied")))
    .orderBy(asc(auditLog.ts), asc(auditLog.action));
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_skills_golden");
  const seed = async (title: string, extra: Record<string, unknown> = {}) =>
    (
      await createSkill(
        {
          tenant_id: ctx.tenantId,
          input: { scope: "global", title, body: `${title} body`, ...extra },
        },
        ctx.db,
      )
    ).id;
  alphaId = await seed("Alpha", { description: REVIEWED, category: "ops" });
  betaId = await seed("Beta", { category: "notion" });
  gammaId = await seed("Gamma", { status: "active" });
  draftId = await seed("Draft", { status: "draft" });
  const foreign = await seedTenant(ctx.db, { slug: "skills-golden-foreign" });
  foreignId = (
    await createSkill(
      { tenant_id: foreign.id, input: { scope: "global", title: "Foreign", body: "Other" } },
      ctx.db,
    )
  ).id;
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-skills@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  const rand = createDeterministicHexFactory(0x5c_11)(16);
  deniedKey = `wf_live_${rand}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      denied.id,
      deniedKey.slice(0, 12),
      createHash("sha256").update(deniedKey).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("skill operations keep their HTTP responses byte for byte", () => {
  test("permission is checked before the body is validated", async () => {
    const id = alphaId;
    record("http.denied.list", await http("GET", "/v1/skills", undefined, deniedKey));
    record("http.denied.create", await http("POST", "/v1/skills", { title: "" }, deniedKey));
    record("http.denied.get", await http("GET", `/v1/skills/${id}`, undefined, deniedKey));
    record("http.denied.patch", await http("PATCH", `/v1/skills/${id}`, { title: "" }, deniedKey));
    record("http.denied.delete", await http("DELETE", `/v1/skills/${id}`, undefined, deniedKey));
    record(
      "http.denied.activate",
      await http("POST", `/v1/skills/${id}/activate`, undefined, deniedKey),
    );
    record(
      "http.denied.archive",
      await http("POST", `/v1/skills/${id}/archive`, undefined, deniedKey),
    );
    record(
      "http.denied.history",
      await http("GET", `/v1/skills/${id}/history`, undefined, deniedKey),
    );
    record(
      "http.denied.history-entry",
      await http("GET", `/v1/skills/${id}/history/${MISSING}`, undefined, deniedKey),
    );
    record(
      "http.denied.restore",
      await http("POST", `/v1/skills/${id}/restore`, { audit_entry_id: "x" }, deniedKey),
    );
    record("http.denied.audit", await deniedTrail());
  });

  test("list", async () => {
    record("http.list", await http("GET", "/v1/skills?sort=title&order=asc"));
    record("http.list.page", await http("GET", "/v1/skills?sort=title&limit=1&offset=1"));
    record("http.list.category", await http("GET", "/v1/skills?category=notion&sort=title"));
    record("http.list.status", await http("GET", "/v1/skills?status=active&sort=title"));
    record("http.list.q", await http("GET", "/v1/skills?q=Gam&sort=title"));
    record("http.list.invalid", await http("GET", "/v1/skills?limit=0"));
  });

  test("get", async () => {
    record("http.get", await http("GET", `/v1/skills/${alphaId}`));
    record("http.get.missing", await http("GET", `/v1/skills/${MISSING}`));
    record("http.get.foreign", await http("GET", `/v1/skills/${foreignId}`));
    record("http.get.invalid", await http("GET", "/v1/skills/not-a-uuid"));
  });

  test("create", async () => {
    const created = await http("POST", "/v1/skills", {
      scope: "global",
      title: "Delta",
      body: "Delta body",
    });
    deltaId = (created.body as { id: string }).id;
    record("http.create", created);
    record("http.create.invalid", await http("POST", "/v1/skills", { scope: "global", title: "" }));
  });

  test("update", async () => {
    record("http.patch", await http("PATCH", `/v1/skills/${betaId}`, { title: "Beta patched" }));
    record(
      "http.patch.body",
      await http("PATCH", `/v1/skills/${betaId}`, { body: "Beta body patched", tags: ["x"] }),
    );
    record(
      "http.patch.accept",
      await http("PATCH", `/v1/skills/${alphaId}`, {
        accept_description: true,
        description: REVIEWED,
      }),
    );
    record(
      "http.patch.accept-invalid",
      await http("PATCH", `/v1/skills/${alphaId}`, { accept_description: true }),
    );
    record(
      "http.patch.accept-stale",
      await http("PATCH", `/v1/skills/${alphaId}`, {
        accept_description: true,
        description: "Outdated description",
      }),
    );
    record(
      "http.patch.version-conflict",
      await http("PATCH", `/v1/skills/${betaId}`, { expected_version: 1, title: "Stale" }),
    );
    record("http.patch.invalid", await http("PATCH", `/v1/skills/${betaId}`, { title: "" }));
    record("http.patch.missing", await http("PATCH", `/v1/skills/${MISSING}`, { title: "Nobody" }));
    record("http.patch.foreign", await http("PATCH", `/v1/skills/${foreignId}`, { title: "No" }));
  });

  test("activate and archive", async () => {
    record("http.activate", await http("POST", `/v1/skills/${betaId}/activate`));
    record("http.activate.again", await http("POST", `/v1/skills/${betaId}/activate`));
    record("http.activate.draft", await http("POST", `/v1/skills/${draftId}/activate`));
    record("http.activate.missing", await http("POST", `/v1/skills/${MISSING}/activate`));
    record("http.archive", await http("POST", `/v1/skills/${gammaId}/archive`));
    record("http.archive.missing", await http("POST", `/v1/skills/${MISSING}/archive`));
    record("http.archive.invalid", await http("POST", "/v1/skills/not-a-uuid/archive"));
  });

  test("history and restore", async () => {
    const history = await http("GET", `/v1/skills/${betaId}/history`);
    record("http.history", history);
    record("http.history.missing", await http("GET", `/v1/skills/${MISSING}/history`));
    const items = (history.body as { items: Array<{ audit_entry_id: string }> }).items;
    const oldest = items[items.length - 1]?.audit_entry_id ?? MISSING;
    const newest = items[0]?.audit_entry_id ?? MISSING;
    record("http.history-entry", await http("GET", `/v1/skills/${betaId}/history/${oldest}`));
    record(
      "http.history-entry.missing",
      await http("GET", `/v1/skills/${betaId}/history/${MISSING}`),
    );
    record(
      "http.history-entry.skill-missing",
      await http("GET", `/v1/skills/${MISSING}/history/${oldest}`),
    );
    record(
      "http.history-entry.invalid",
      await http("GET", `/v1/skills/${betaId}/history/not-a-uuid`),
    );
    record(
      "http.restore",
      await http("POST", `/v1/skills/${betaId}/restore`, { audit_entry_id: oldest }),
    );
    record(
      "http.restore.mismatch",
      await http("POST", `/v1/skills/${alphaId}/restore`, { audit_entry_id: newest }),
    );
    record(
      "http.restore.unknown-entry",
      await http("POST", `/v1/skills/${betaId}/restore`, { audit_entry_id: MISSING }),
    );
    record(
      "http.restore.missing",
      await http("POST", `/v1/skills/${MISSING}/restore`, { audit_entry_id: oldest }),
    );
    record("http.restore.invalid", await http("POST", `/v1/skills/${betaId}/restore`, {}));
  });

  test("delete", async () => {
    record("http.delete", await http("DELETE", `/v1/skills/${gammaId}`));
    record("http.delete.missing", await http("DELETE", `/v1/skills/${gammaId}`));
  });

  test("audit rows", async () => {
    record("http.audit.alpha", await auditTrail(alphaId));
    record("http.audit.beta", await auditTrail(betaId));
    record("http.audit.gamma", await auditTrail(gammaId));
    record("http.audit.draft", await auditTrail(draftId));
    record("http.audit.delta", await auditTrail(deltaId));
  });
});

describe("skill tools keep their results byte for byte", () => {
  test("list_all_skills", async () => {
    record("tool.list", await listAllSkillsTool.execute(toolCtx(), {}));
    record("tool.list.page", await listAllSkillsTool.execute(toolCtx(), { limit: 1, offset: 1 }));
    record("tool.list.end", await listAllSkillsTool.execute(toolCtx(), { limit: 2, offset: 2 }));
    record("tool.list.descriptor", {
      name: listAllSkillsTool.name,
      description: listAllSkillsTool.description,
      category: listAllSkillsTool.category,
      permission: listAllSkillsTool.permission,
      use_case: listAllSkillsTool.use_case,
      important_notes: listAllSkillsTool.important_notes,
      rejects_large_limit: listAllSkillsTool.inputSchema.safeParse({ limit: 201 }).success,
    });
  });

  test("get_skill", async () => {
    record("tool.get", await getSkillTool.execute(toolCtx(), { id: alphaId }));
    record("tool.get.missing", await getSkillTool.execute(toolCtx(), { id: MISSING }));
    record("tool.get.foreign", await getSkillTool.execute(toolCtx(), { id: foreignId }));
    record("tool.get.descriptor", {
      name: getSkillTool.name,
      description: getSkillTool.description,
      category: getSkillTool.category,
      permission: getSkillTool.permission,
      use_case: getSkillTool.use_case,
      important_notes: getSkillTool.important_notes,
      rejects_slug: getSkillTool.inputSchema.safeParse({ id: "alpha" }).success,
    });
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
