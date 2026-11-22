import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import { reviewDraftWithCritic } from "../../conversations/authoring-critic/critic-agent.ts";
import { auditLog, skillCandidates, skills } from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { CONVENTIONS_HEADING } from "../../llm/runtime/context-assembler/formatters.ts";
import { assembleEnhancedPrompt } from "../../llm/runtime/context-assembler.ts";
import { loadActiveConventions } from "../../skills/conventions.ts";
import { getSkill, listSkillHistory, restoreSkill } from "../../skills/service.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

const COLLECTED_ZONE = "America/New_York";
const TIMEZONE_RULE = {
  rule_id: "tenant-timezone",
  type: "timezone",
  statement: "Schedules and dates use the tenant time zone Europe/Berlin.",
  payload: { value: "Europe/Berlin" },
} as const;

let ctx: HttpTestServer;

async function ensureMockConfig(): Promise<void> {
  try {
    getConfig();
  } catch {
    await loadConfig({
      env: {
        DATABASE_URL: "postgres://placeholder/intake-skill-conventions",
        NODE_ENV: "test",
        LLM_PROVIDER: "mock",
      },
      configPathOverride: join(mkdtempSync(join(tmpdir(), "subkit-cfg-conventions-")), "c.json"),
    });
  }
  await setConfigKey(["llm", "provider"], "mock");
}

beforeAll(async () => {
  await ensureMockConfig();
  resetMockProvider();
  ctx = await createHttpTestServer("intake-skill-conventions");
});

afterAll(async () => {
  await setConfigKey(["llm", "critic", "enabled"], false);
  await ctx.cleanup();
});

function apiRequest(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function browserConfirm(path: string, body: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: await browserSessionHeaders(ctx, ctx.userId),
    body: JSON.stringify(body),
  });
}

interface ProposalView {
  id: string;
  current_revision: number;
  status: string;
  confirmed_target_id: string | null;
  revision: { digest: string; target: { skill: { rules?: unknown[] } } };
}

async function collectNote(requestId: string, body: string): Promise<string> {
  const response = await apiRequest("/v1/intake/items", "POST", {
    client_request_id: requestId,
    category: "conventions",
    title: "Tenant conventions note",
    captured_at: "2026-10-10T07:00:00.000Z",
    body,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function propose(itemId: string, target: unknown): Promise<ProposalView> {
  const response = await apiRequest("/v1/intake/proposals", "POST", {
    item_ids: [itemId],
    title: "Tenant conventions",
    body: "Confirmed conventions of this tenant.",
    target,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as ProposalView;
}

function confirmation(proposal: ProposalView) {
  return {
    path: `/v1/intake/proposals/${proposal.id}/confirm`,
    body: { expected_revision: proposal.current_revision, digest: proposal.revision.digest },
  };
}

describe("typed skill rules published through intake", () => {
  let skillId: string;

  test("an API key cannot publish rules; the signed-in person can", async () => {
    const itemId = await collectNote(
      "20000000-0000-4000-8000-000000000001",
      `Our schedules should run in ${COLLECTED_ZONE}.`,
    );
    const proposal = await propose(itemId, {
      skill: {
        new: { title: "Tenant conventions", scope: "global", tags: [], category: "conventions" },
        rules: [TIMEZONE_RULE],
      },
    });
    expect(proposal.revision.target.skill.rules).toEqual([TIMEZONE_RULE]);
    const { path, body } = confirmation(proposal);

    const byKey = await apiRequest(path, "POST", body);
    expect(byKey.status).toBe(403);
    expect(
      await ctx.db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.tenant_id, ctx.tenantId), eq(skills.title, "Tenant conventions"))),
    ).toEqual([]);

    const confirmed = await browserConfirm(path, body);
    expect(confirmed.status).toBe(200);
    const view = (await confirmed.json()) as ProposalView;
    expect(view.status).toBe("confirmed");
    skillId = view.confirmed_target_id ?? "";

    const skill = await getSkill(ctx.tenantId, skillId, ctx.db);
    expect(skill?.rules).toEqual([TIMEZONE_RULE]);
    expect(skill?.domains).toEqual([]);

    const [published] = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "skill.rules.published"),
          eq(auditLog.resource_id, skillId),
        ),
      );
    expect(published?.actor_type).toBe("user");
    expect(published?.actor_id).toBe(ctx.userId);
    expect(published?.before).toEqual({ rule_ids: [], domains: [] });
    expect(published?.after).toEqual({ rule_ids: ["tenant-timezone"], domains: [] });
    expect(published?.metadata).toMatchObject({
      proposal_id: proposal.id,
      revision: proposal.current_revision,
      digest: proposal.revision.digest,
    });
  });

  test("the skills API cannot write rules and restore keeps the published ones", async () => {
    const before = await getSkill(ctx.tenantId, skillId, ctx.db);
    const patched = await apiRequest(`/v1/skills/${skillId}`, "PATCH", {
      body: "Edited body.",
      rules: [{ ...TIMEZONE_RULE, payload: { value: COLLECTED_ZONE } }],
      domains: ["billing"],
    });
    expect(patched.status).toBe(200);
    const after = await getSkill(ctx.tenantId, skillId, ctx.db);
    expect(after?.body).toBe("Edited body.");
    expect(after?.rules).toEqual([TIMEZONE_RULE]);
    expect(after?.domains).toEqual([]);

    const created = await apiRequest("/v1/skills", "POST", {
      scope: "global",
      title: "Direct skill",
      body: "Direct body.",
      rules: [TIMEZONE_RULE],
    });
    expect(created.status).toBe(201);
    const direct = await getSkill(
      ctx.tenantId,
      ((await created.json()) as { id: string }).id,
      ctx.db,
    );
    expect(direct?.rules).toEqual([]);

    const history = await listSkillHistory(ctx.tenantId, skillId, ctx.db);
    const first = history.at(-1);
    expect(first).toBeDefined();
    const restored = await restoreSkill(
      ctx.tenantId,
      skillId,
      first?.audit_entry_id ?? "",
      ctx.userId,
      ctx.db,
      "user",
    );
    expect(restored?.rules).toEqual(before?.rules ?? []);
  });

  test("changing the rules needs a new review", async () => {
    const skill = await getSkill(ctx.tenantId, skillId, ctx.db);
    const itemId = await collectNote("20000000-0000-4000-8000-000000000002", "Clear the rules.");
    const target = (rules: unknown[]) => ({
      skill: { skill_id: skillId, expected_version: skill?.version, rules },
    });
    const proposal = await propose(itemId, target([TIMEZONE_RULE]));
    const revised = await apiRequest(`/v1/intake/proposals/${proposal.id}`, "PATCH", {
      expected_revision: proposal.current_revision,
      item_ids: [itemId],
      title: "Tenant conventions",
      body: "Confirmed conventions of this tenant.",
      target: target([]),
    });
    expect(revised.status).toBe(200);
    const next = (await revised.json()) as ProposalView;
    expect(next.revision.digest).not.toBe(proposal.revision.digest);
    const stale = await browserConfirm(`/v1/intake/proposals/${proposal.id}/confirm`, {
      expected_revision: next.current_revision,
      digest: proposal.revision.digest,
    });
    expect(stale.status).toBe(409);
    expect((await getSkill(ctx.tenantId, skillId, ctx.db))?.rules).toEqual([TIMEZONE_RULE]);
    await apiRequest(`/v1/intake/proposals/${proposal.id}/reject`, "POST", {
      expected_revision: next.current_revision,
    });
  });

  test("Fertig, wenn: the published timezone rule reaches the assembler section and the critic rubric, collected material does not", async () => {
    await ctx.db.insert(skillCandidates).values({
      tenant_id: ctx.tenantId,
      scope: "global",
      pattern_kind: "authoring_capability",
      title: "Collected timezone hint",
      body: `Always schedule in ${COLLECTED_ZONE}.`,
      evidence: [],
      confidence: "high",
      fingerprint: "conventions-collected-timezone",
    });

    for (const flow of ["generate", "converse"] as const) {
      const prompt = await assembleEnhancedPrompt(
        {
          tenant_id: ctx.tenantId,
          flow,
          user_turns: [{ role: "user", content: "Send the daily digest every morning" }],
          max_tokens: 60_000,
          model: "mock",
        },
        ctx.db,
      );
      const section = prompt.system_sections?.find((s) => s.text.startsWith(CONVENTIONS_HEADING));
      expect(section?.volatile).toBe(false);
      expect(section?.text).toContain("tenant-timezone [timezone]");
      expect(section?.text).toContain('{"value":"Europe/Berlin"}');
      expect(prompt.system).not.toContain(COLLECTED_ZONE);
      expect(prompt.system).not.toContain("Collected timezone hint");
      expect(prompt.token_counts.conventions).toBeGreaterThan(0);
    }

    await setConfigKey(["llm", "critic", "enabled"], true);
    await setConfigKey(["llm", "critic", "min_steps"], 2);
    let criticInput = "";
    getMockProvider().generateOverrides.critic_authoring = (last) => {
      criticInput = last;
      return {
        passed: true,
        repairs: [],
        rationale: "The digest matches the goal.",
        rubric: [{ rule_id: "tenant-timezone", status: "fail", note: "The schedule has no tz." }],
      };
    };
    const outcome = await reviewDraftWithCritic({
      tool: "edit_workflow_patch",
      draft: {
        name: "Daily digest",
        slug: "daily-digest",
        steps: [
          { id: "load", kind: "transform", language: "javascript", expression: "return [];" },
          { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
        ],
        trigger: { kind: "schedule", cron: "0 7 * * *", tz: "UTC" },
      },
      goal: "Send the daily digest every morning",
      convention_scope: {},
      tenant_id: ctx.tenantId,
      conversation_id: "00000000-0000-4000-8000-0000000000d1",
      recentDriftCount: 0,
      loadConsecutiveRejections: async () => 0,
      db: ctx.db,
    });
    expect(criticInput).toContain("Convention rubric");
    expect(criticInput).toContain("- tenant-timezone [timezone]");
    expect(criticInput).not.toContain(COLLECTED_ZONE);
    expect(outcome.result).toBe("pass");
    expect(outcome.rubric).toEqual([
      { rule_id: "tenant-timezone", status: "fail", note: "The schedule has no tz." },
    ]);
    expect(outcome.rubric_warnings.map((item) => item.rule_id)).toEqual(["tenant-timezone"]);
  });

  test("another tenant never sees the rules", async () => {
    const other = await seedTenant(ctx.db, {
      slug: "t-conventions-other",
      display_name: "Other tenant",
    });
    const active = await loadActiveConventions(other.id, {}, ctx.db);
    expect(active.conventions).toEqual([]);
    const own = await loadActiveConventions(ctx.tenantId, {}, ctx.db);
    expect(own.conventions.map((entry) => entry.rule.rule_id)).toEqual(["tenant-timezone"]);
  });

  test("domains limit the rules to matching workflow and connector categories", async () => {
    const itemId = await collectNote("20000000-0000-4000-8000-000000000003", "Billing currency.");
    const proposal = await propose(itemId, {
      skill: {
        new: { title: "Billing conventions", scope: "global", tags: [], category: "billing" },
        rules: [
          {
            rule_id: "billing-currency",
            type: "currency",
            statement: "Billing amounts are in euro.",
            payload: { code: "EUR" },
          },
        ],
        domains: ["billing"],
      },
    });
    const { path, body } = confirmation(proposal);
    expect((await browserConfirm(path, body)).status).toBe(200);
    const ids = async (categories: string[]) =>
      (await loadActiveConventions(ctx.tenantId, { categories }, ctx.db)).conventions.map(
        (entry) => entry.rule.rule_id,
      );
    expect(await ids([])).toEqual(["tenant-timezone"]);
    expect(await ids(["billing"])).toEqual(["billing-currency", "tenant-timezone"]);
    const [audit] = await ctx.db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "skill.rules.published")),
      )
      .orderBy(desc(auditLog.ts))
      .limit(1);
    expect(audit?.after).toEqual({ rule_ids: ["billing-currency"], domains: ["billing"] });
  });
});
