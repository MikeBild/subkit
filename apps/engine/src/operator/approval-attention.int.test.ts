import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import {
  tenants,
  users,
  webhooksInbound,
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { addWorkflowVersion, seedPatchableWorkflow } from "../test-helpers/patch-candidates.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import {
  AUTHORITY_EXTEND_BELOW_RUN_SHARE,
  AUTHORITY_EXTEND_WITHIN_DAYS,
} from "../workflows/authority-extension.ts";
import { GMAIL_SEND_TARGET } from "../workflows/report-delivery-boundary.ts";
import { type AttentionItem, buildAttention, invalidateAttention } from "./attention.ts";
import { attentionLine } from "./health-digest.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
let testDb: TestDb;
let tenant_id: string;
let owner: ResolvedPrincipal;
let now: Date;
let counter = 0;

beforeAll(async () => {
  testDb = await createTestDb("operator-approval-attention");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-approval-attention", display_name: "Approval attention" })
    .returning();
  if (!tenant) throw new Error("tenant fixture");
  tenant_id = tenant.id;
  const [user] = await testDb.db
    .insert(users)
    .values({
      tenant_id,
      email: "owner@approval",
      role_id: await builtinRoleId(testDb.db, "admin"),
    })
    .returning();
  if (!user) throw new Error("user fixture");
  owner = adminPrincipal(tenant_id, user.id);
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(() => {
  invalidateAttention();
  now = new Date(getTestNow() + 5_000);
});

async function workflow(label: string) {
  const slug = `approval-${label}-${++counter}`;
  return { slug, ...(await seedPatchableWorkflow(testDb.db, tenant_id, slug, slug)) };
}

async function schedule(
  workflow_id: string,
  values: Partial<typeof workflowsSchedules.$inferInsert> = {},
) {
  const [row] = await testDb.db
    .insert(workflowsSchedules)
    .values({ tenant_id, workflow_id, cron: "0 7 * * *", execution_mode: "prod", ...values })
    .returning();
  if (!row) throw new Error("schedule fixture");
  return row;
}

async function hook(workflow_id: string, slug: string) {
  const [row] = await testDb.db
    .insert(webhooksInbound)
    .values({
      tenant_id,
      workflow_id,
      slug,
      verifier: "standard",
      secret_ciphertext: Buffer.alloc(1),
      secret_iv: Buffer.alloc(1),
      secret_auth_tag: Buffer.alloc(1),
    })
    .returning();
  if (!row) throw new Error("hook fixture");
  return row;
}

async function approve(
  workflow_id: string,
  workflow_version_id: string,
  values: Partial<typeof workflowExecutionAuthorities.$inferInsert> = {},
) {
  const base = getTestNow();
  await testDb.db.insert(workflowExecutionAuthorities).values({
    tenant_id,
    workflow_id,
    workflow_version_id,
    effect_manifest_digest: "0".repeat(64),
    effect_manifest: {},
    execution_environment: "prod",
    target_constraints: { targets: [] },
    valid_from: new Date(base - HOUR),
    valid_until: new Date(base + 20 * DAY),
    max_runs: 30,
    reserved_runs: 0,
    created_by: owner.id,
    ...values,
  });
}

async function itemsOf(workflow_id: string): Promise<AttentionItem[]> {
  invalidateAttention();
  const { items } = await buildAttention(testDb.db, owner, { now });
  return items.filter((item) => item.subject?.id === workflow_id);
}

describe("a version nobody has approved yet", () => {
  test("says what it reaches beyond the approval that did not follow it", async () => {
    const wf = await workflow("grown");
    await schedule(wf.workflow_id);
    const growth = [
      {
        kind: "new_connector",
        connector_id: "00000000-0000-4000-8000-0000000000aa",
        connector_name: "Ticket desk",
        target: "https://desk.example.test/tickets",
        effect: "write",
      },
    ];
    await testDb.db
      .update(workflowVersions)
      .set({ authority_growth: { prod: growth, dev: [] } })
      .where(eq(workflowVersions.id, wf.version_id));
    const [item] = await itemsOf(wf.workflow_id);
    expect(item).toMatchObject({
      reason: "version_awaiting_approval",
      approval: { version: 1, environment: "prod", growth },
    });
  });

  test("is listed as soon as a schedule would start it — before any refusal", async () => {
    const wf = await workflow("scheduled");
    await schedule(wf.workflow_id);
    const [item, ...rest] = await itemsOf(wf.workflow_id);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      id: `workflow:${wf.workflow_id}`,
      class: "decide",
      severity: "urgent",
      reason: "version_awaiting_approval",
      trigger: { kind: "schedule", name: null },
      approval: { version: 1, environment: "prod" },
    });
    expect(item?.deadline).not.toBeNull();
    expect(Date.parse(item?.deadline ?? "")).toBeGreaterThan(now.getTime());
    expect(item?.since).not.toBeNull();
    expect(item?.actions).toEqual([
      {
        verb: "open",
        href: `/cockpit/workflows/${wf.workflow_id}#workflow-automation`,
        primary: true,
        permission: "workflow:write",
      },
    ]);
    expect(attentionLine(item as AttentionItem)).toBe(
      `- [decide] workflow "${wf.slug}": version awaiting approval (v1, prod)`,
    );
  });

  test("is listed for a webhook too, in production, named by its hook", async () => {
    const wf = await workflow("hooked");
    await hook(wf.workflow_id, `${wf.slug}-in`);
    const [item, ...rest] = await itemsOf(wf.workflow_id);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      reason: "version_awaiting_approval",
      trigger: { kind: "inbound_hook", name: `${wf.slug}-in` },
      approval: { version: 1, environment: "prod" },
      deadline: null,
    });
  });

  test("names the new version once one is saved over an approved one", async () => {
    const wf = await workflow("resaved");
    await schedule(wf.workflow_id);
    await approve(wf.workflow_id, wf.version_id);
    expect(await itemsOf(wf.workflow_id)).toEqual([]);
    await addWorkflowVersion(testDb.db, tenant_id, wf.workflow_id, 2);
    const [item] = await itemsOf(wf.workflow_id);
    expect(item).toMatchObject({
      reason: "version_awaiting_approval",
      approval: { version: 2, environment: "prod" },
    });
  });

  test("the first refused start takes the same item over — never a second one", async () => {
    const wf = await workflow("held");
    const row = await schedule(wf.workflow_id);
    const before = await itemsOf(wf.workflow_id);
    expect(before.map((item) => item.reason)).toEqual(["version_awaiting_approval"]);
    await testDb.db
      .update(workflowsSchedules)
      .set({
        admission_hold: {
          reason_code: "execution_authority_required",
          observed_at: new Date(getTestNow()).toISOString(),
        },
      })
      .where(and(eq(workflowsSchedules.tenant_id, tenant_id), eq(workflowsSchedules.id, row.id)));
    const after = await itemsOf(wf.workflow_id);
    expect(after.map((item) => [item.id, item.class, item.reason])).toEqual([
      [`workflow:${wf.workflow_id}`, "stopped", "execution_authority_required"],
    ]);
    expect(after[0]?.id).toBe(before[0]?.id ?? "");
    expect(after[0]?.approval).toBeUndefined();
  });

  test("a held trigger beside an unheld one is still one item, and the hold speaks", async () => {
    const wf = await workflow("mixed");
    await schedule(wf.workflow_id, {
      admission_hold: {
        reason_code: "execution_authority_unavailable",
        observed_at: new Date(getTestNow()).toISOString(),
      },
    });
    await hook(wf.workflow_id, `${wf.slug}-in`);
    expect((await itemsOf(wf.workflow_id)).map((item) => item.reason)).toEqual([
      "execution_authority_unavailable",
    ]);
  });

  test("is not listed where nothing would start it", async () => {
    const paused = await workflow("paused");
    await schedule(paused.workflow_id, { paused: true });
    const off = await hook(paused.workflow_id, `${paused.slug}-in`);
    await testDb.db
      .update(webhooksInbound)
      .set({ active: false })
      .where(and(eq(webhooksInbound.tenant_id, tenant_id), eq(webhooksInbound.id, off.id)));
    expect(await itemsOf(paused.workflow_id)).toEqual([]);
    const manual = await workflow("manual");
    expect(await itemsOf(manual.workflow_id)).toEqual([]);
    const draft = await workflow("draft");
    await schedule(draft.workflow_id);
    await testDb.db
      .update(workflows)
      .set({ lifecycle: "draft" })
      .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, draft.workflow_id)));
    expect(await itemsOf(draft.workflow_id)).toEqual([]);
  });

  test("an approval for another environment or version does not cover it", async () => {
    const wf = await workflow("elsewhere");
    await schedule(wf.workflow_id);
    await approve(wf.workflow_id, wf.version_id, { execution_environment: "dev" });
    expect((await itemsOf(wf.workflow_id)).map((item) => item.reason)).toEqual([
      "version_awaiting_approval",
    ]);
    const base = getTestNow();
    const spent = await workflow("spent");
    await schedule(spent.workflow_id);
    await approve(spent.workflow_id, spent.version_id, {
      revoked_at: new Date(base - HOUR),
      revoked_by: owner.id,
    });
    await approve(spent.workflow_id, spent.version_id, {
      valid_from: new Date(base - 2 * DAY),
      valid_until: new Date(base - HOUR),
    });
    await approve(spent.workflow_id, spent.version_id, { max_runs: 5, reserved_runs: 5 });
    expect((await itemsOf(spent.workflow_id)).map((item) => item.reason)).toEqual([
      "version_awaiting_approval",
    ]);
  });
});

describe("an approval that is about to end", () => {
  test("is a notice with its end as the deadline", async () => {
    const wf = await workflow("ending");
    await schedule(wf.workflow_id);
    const until = new Date(getTestNow() + (AUTHORITY_EXTEND_WITHIN_DAYS - 1) * DAY);
    await approve(wf.workflow_id, wf.version_id, { valid_until: until });
    const [item, ...rest] = await itemsOf(wf.workflow_id);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      class: "decide",
      severity: "notice",
      reason: "approval_expiring",
      approval: { version: 1, environment: "prod" },
      deadline: until.toISOString(),
      since: null,
    });
    expect(item?.actions[0]).toMatchObject({
      verb: "open",
      href: `/cockpit/workflows/${wf.workflow_id}#workflow-automation`,
    });
  });

  test("is a notice without a date when its runs are what runs out", async () => {
    const wf = await workflow("spending");
    await hook(wf.workflow_id, `${wf.slug}-in`);
    expect(1 / 20).toBeLessThan(AUTHORITY_EXTEND_BELOW_RUN_SHARE);
    await approve(wf.workflow_id, wf.version_id, { max_runs: 20, reserved_runs: 19 });
    const [item] = await itemsOf(wf.workflow_id);
    expect(item).toMatchObject({
      severity: "notice",
      reason: "approval_expiring",
      trigger: { kind: "inbound_hook", name: `${wf.slug}-in` },
      deadline: null,
    });
  });

  test("is not listed while another approval still has room", async () => {
    const wf = await workflow("extended");
    await schedule(wf.workflow_id);
    await approve(wf.workflow_id, wf.version_id, { valid_until: new Date(getTestNow() + DAY) });
    expect((await itemsOf(wf.workflow_id)).map((item) => item.reason)).toEqual([
      "approval_expiring",
    ]);
    await approve(wf.workflow_id, wf.version_id);
    expect(await itemsOf(wf.workflow_id)).toEqual([]);
  });

  test("is never listed for an approval that stands until revoked", async () => {
    const wf = await workflow("open-ended");
    await schedule(wf.workflow_id);
    await approve(wf.workflow_id, wf.version_id, {
      valid_until: null,
      max_runs: null,
      reserved_runs: 5_000,
    });
    expect(await itemsOf(wf.workflow_id)).toEqual([]);
  });

  test("still warns about runs running out when only the end date is open", async () => {
    const wf = await workflow("open-date-limited-runs");
    await schedule(wf.workflow_id);
    await approve(wf.workflow_id, wf.version_id, {
      valid_until: null,
      max_runs: 20,
      reserved_runs: 19,
    });
    const [item] = await itemsOf(wf.workflow_id);
    expect(item).toMatchObject({ reason: "approval_expiring", deadline: null });
  });

  test("is not listed with room on both counts, nor without a trigger", async () => {
    const calm = await workflow("calm");
    await schedule(calm.workflow_id);
    await approve(calm.workflow_id, calm.version_id);
    expect(await itemsOf(calm.workflow_id)).toEqual([]);
    const manual = await workflow("manual-ending");
    await approve(manual.workflow_id, manual.version_id, {
      valid_until: new Date(getTestNow() + HOUR),
    });
    expect(await itemsOf(manual.workflow_id)).toEqual([]);
  });
});

describe("a version no approval may cover", () => {
  const SENDER = "ops@example.com";
  const bounded = {
    name: "bounded",
    steps: [{ kind: "transform", id: "shape", language: "javascript", expression: "return {};" }],
  };
  const unbounded = {
    name: "unbounded",
    steps: [
      {
        kind: "request",
        id: "fetch_target",
        method: "GET",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow substitution
        url: "${input.target}",
      },
    ],
  };
  const unprepared = {
    name: "unprepared",
    steps: [
      {
        kind: "transform",
        id: "compose",
        language: "javascript",
        expression: `return { raw: sk.base64UrlEncode('From: ${SENDER}\\r\\nTo: ${SENDER}\\r\\nSubject: r\\r\\nContent-Type: text/html; charset=UTF-8\\r\\n\\r\\n<p>r</p>') };`,
      },
      {
        kind: "request",
        id: "send_report",
        method: "POST",
        url: GMAIL_SEND_TARGET,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow substitution
        body: { raw: "${scope.compose.data.raw}" },
      },
    ],
  };

  async function version(workflow_id: string, n: number, dag: unknown, current = true) {
    const [row] = await testDb.db
      .insert(workflowVersions)
      .values({ tenant_id, workflow_id, version: n, dag })
      .returning();
    if (!row) throw new Error("version fixture");
    await testDb.db
      .update(workflows)
      .set(current ? { current_version_id: row.id } : { draft_version_id: row.id })
      .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow_id)));
    return row.id;
  }

  test("is never offered for approval: the item names the step and the act that unblocks it", async () => {
    const wf = await workflow("unbounded");
    await version(wf.workflow_id, 2, unbounded);
    await schedule(wf.workflow_id);
    const [item, ...rest] = await itemsOf(wf.workflow_id);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      class: "decide",
      reason: "version_needs_repair",
      approval: { version: 2, environment: "prod" },
      repair: { step_id: "fetch_target", remedy_kind: "author", steps: 1 },
    });
    expect(item?.repair?.code).toBeTruthy();
    expect(item?.actions).toEqual([
      {
        verb: "chat",
        href: `/cockpit/chat/new?workflow_id=${wf.workflow_id}`,
        primary: true,
        permission: "conversation:write",
      },
    ]);
    expect(attentionLine(item as AttentionItem)).toContain('step "fetch_target"');
  });

  test("a step a trial run unblocks leads to the panel where the trial run starts", async () => {
    const wf = await workflow("unprepared");
    await version(wf.workflow_id, 2, unprepared);
    await hook(wf.workflow_id, `${wf.slug}-in`);
    const [item] = await itemsOf(wf.workflow_id);
    expect(item).toMatchObject({
      reason: "version_needs_repair",
      trigger: { kind: "inbound_hook", name: `${wf.slug}-in` },
      repair: {
        step_id: "send_report",
        code: "report_delivery_unprepared",
        remedy_kind: "prepare",
      },
    });
    expect(item?.actions).toEqual([
      {
        verb: "open",
        href: `/cockpit/workflows/${wf.workflow_id}#workflow-automation`,
        primary: true,
        permission: "workflow:run",
      },
    ]);
  });

  test("is judged on the running version, never on a draft beside it", async () => {
    const blocked = await workflow("draft-beside");
    await version(blocked.workflow_id, 2, unbounded);
    await version(blocked.workflow_id, 3, unprepared, false);
    await schedule(blocked.workflow_id);
    const [item] = await itemsOf(blocked.workflow_id);
    expect(item).toMatchObject({
      reason: "version_needs_repair",
      repair: { step_id: "fetch_target" },
    });
    const fine = await workflow("fine-draft");
    await version(fine.workflow_id, 2, bounded);
    await version(fine.workflow_id, 3, unbounded, false);
    await schedule(fine.workflow_id);
    const [awaiting] = await itemsOf(fine.workflow_id);
    expect(awaiting?.reason).toBe("version_awaiting_approval");
    expect(awaiting?.repair).toBeUndefined();
  });
});
