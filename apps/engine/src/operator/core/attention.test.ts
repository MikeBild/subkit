import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  APPROVAL_NEEDED_REASONS,
  ATTENTION_REASONS,
  ATTENTION_SCHEMA_VERSION,
  ATTENTION_SOURCES,
  ATTENTION_SUBJECT_KINDS,
  type AttentionItem,
  type AttentionReason,
  type AttentionV1,
  attentionAllClear,
  attentionSnoozeKey,
  compareAttentionItems,
  heldAttentionReason,
  needsApproval,
  planSnooze,
  projectAttentionItems,
  SNOOZE_MAX_MS,
  splitSnoozed,
} from "./attention.ts";

test("exactly the approval reasons ask someone to approve", () => {
  const approvals: AttentionReason[] = [
    "execution_authority_required",
    "execution_authority_expired",
    "execution_authority_exhausted",
    "execution_authority_revoked",
    "execution_authority_changed",
    "version_awaiting_approval",
    "approval_expiring",
    "task_grant_required",
    "task_grant_expiring",
  ];
  expect(ATTENTION_REASONS.filter((reason) => needsApproval({ reason }))).toEqual(approvals);
  expect([...APPROVAL_NEEDED_REASONS].sort()).toEqual([...approvals].sort());
  for (const reason of ["", "input_required", "schedule_auto_paused", "approval"])
    expect(needsApproval({ reason })).toBe(false);
});

test("attention schema publishes its stable sources, reasons, and subject kinds", () => {
  expect(ATTENTION_SCHEMA_VERSION).toBe("attention.v1");
  expect(ATTENTION_SOURCES).toEqual([
    "conversations",
    "schedules",
    "freshness",
    "failures",
    "patches",
    "connectors",
    "connections",
    "secret_approvals",
    "skills",
    "intake",
    "budget",
    "ai_access",
    "risk",
    "tasks",
  ]);
  expect(ATTENTION_REASONS).toEqual([
    "awaiting_answer",
    "execution_authority_required",
    "execution_authority_expired",
    "execution_authority_exhausted",
    "execution_authority_revoked",
    "execution_authority_changed",
    "input_required",
    "version_awaiting_approval",
    "version_needs_repair",
    "approval_expiring",
    "schedule_auto_paused",
    "scheduler_stale",
    "failing",
    "patch_proposed",
    "needs_reauth",
    "needs_update",
    "degraded",
    "unhealthy",
    "refresh_refused",
    "refresh_failed",
    "expired_no_refresh",
    "secret_unreadable",
    "secret_prepared",
    "skills_proposed",
    "intake_collected",
    "spend_warning",
    "spend_limit_reached",
    "spend_limit_unset",
    "ai_access_missing",
    "model_tools_missing",
    "risk_critical",
    "task_run_failed",
    "task_result_ready",
    "task_grant_required",
    "task_grant_expiring",
    "task_owner_unavailable",
    "pair_approval_requested",
    "device_offline_waiting",
    "local_confirmation_needed",
    "device_permission_missing",
    "device_handover_waiting",
    "knowledge_review_due",
    "folder_changed",
  ]);
  expect(ATTENTION_SUBJECT_KINDS).toEqual([
    "workflow",
    "conversation",
    "connector",
    "connection",
    "secret",
    "settings",
    "task",
    "device",
  ]);
});

const item = (id: string): AttentionItem => ({
  id,
  class: "decide",
  severity: "notice",
  kind: "workflow",
  subject: null,
  reason: "approval_expiring",
  trigger: null,
  cause_class: null,
  counts: {},
  since: null,
  deadline: null,
  detail: null,
  actions: [],
});
const sources = Object.fromEntries(
  ATTENTION_SOURCES.map((source) => [source, "answered"]),
) as AttentionV1["sources"];
const empty: AttentionV1 = {
  schema_version: "attention.v1",
  generated_at: "2026-11-09T00:00:00.000Z",
  sources,
  status: null,
  items: [],
  snoozed: [],
};

test("all-clear requires no items and no failed source, even when some sources are not permitted", () => {
  expect(attentionAllClear(empty)).toBe(true);
  expect(attentionAllClear({ ...empty, items: [item("task")] })).toBe(false);
  for (const source of ATTENTION_SOURCES) {
    expect(attentionAllClear({ ...empty, sources: { ...sources, [source]: "failed" } })).toBe(
      false,
    );
    expect(
      attentionAllClear({ ...empty, sources: { ...sources, [source]: "not_permitted" } }),
    ).toBe(true);
  }
});

test("redacting hook names cannot modify cached facts or another caller's authorized view", () => {
  const hook = Object.freeze({
    ...item("hook"),
    trigger: Object.freeze({ kind: "inbound_hook" as const, name: "private hook" }),
  });
  const scheduled = Object.freeze({
    ...item("schedule"),
    trigger: Object.freeze({ kind: "schedule" as const, name: "morning" }),
  });
  const values = Object.freeze([scheduled, hook, Object.freeze(item("plain"))]);
  const before = JSON.stringify(values);
  expect(
    projectAttentionItems(values, false).find((entry) => entry.id === "hook")?.trigger,
  ).toEqual({ kind: "inbound_hook", name: null });
  expect(
    projectAttentionItems(values, false).find((entry) => entry.id === "schedule")?.trigger?.name,
  ).toBe("morning");
  expect(
    projectAttentionItems(values, true).find((entry) => entry.id === "hook")?.trigger?.name,
  ).toBe("private hook");
  expect(JSON.stringify(values)).toBe(before);
});

test("comparator handles both orders of missing dates and equal IDs", () => {
  const a = item("a");
  const b = item("b");
  expect(compareAttentionItems(a, a)).toBe(0);
  expect(compareAttentionItems(a, b)).toBe(-1);
  expect(compareAttentionItems(b, a)).toBe(1);
  for (const key of ["deadline", "since"] as const) {
    expect(compareAttentionItems(a, { ...b, [key]: "2026-01-01" })).toBe(1);
    expect(compareAttentionItems({ ...a, [key]: "2026-01-01" }, b)).toBe(-1);
    expect(
      compareAttentionItems({ ...a, [key]: "2026-01-01" }, { ...b, [key]: "2026-02-01" }),
    ).toBe(-1);
    expect(
      compareAttentionItems({ ...a, [key]: "2026-02-01" }, { ...b, [key]: "2026-01-01" }),
    ).toBe(1);
  }
});

test("projected order is deterministic and idempotent without mutating source order", () => {
  fc.assert(
    fc.property(fc.uniqueArray(fc.string(), { maxLength: 30 }), (ids) => {
      const items = Object.freeze(ids.map((id) => Object.freeze(item(id))));
      const before = JSON.stringify(items);
      const projected = projectAttentionItems(items, true);
      expect(projectAttentionItems([...items].reverse(), true)).toEqual(projected);
      expect(projectAttentionItems(projected, true)).toEqual(projected);
      expect(JSON.stringify(items)).toBe(before);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});

test("missing dates sort after present year-only timestamps", () => {
  for (const key of ["deadline", "since"] as const) {
    const absent = item("absent");
    const present = { ...item("present"), [key]: "2026" };
    expect(compareAttentionItems(absent, present)).toBe(1);
    expect(compareAttentionItems(present, absent)).toBe(-1);
  }
});

test("equal present dates defer to the remaining date and stable ID order", () => {
  const a = { ...item("a"), deadline: "2026-01-01", since: "2025-01-01" };
  const b = { ...item("b"), deadline: "2026-01-01", since: "2025-01-01" };
  expect(compareAttentionItems(a, b)).toBe(-1);
  expect(compareAttentionItems(b, a)).toBe(1);
  expect(compareAttentionItems(a, a)).toBe(0);
});

const TASK_REASONS = [
  "task_run_failed",
  "task_result_ready",
  "task_grant_required",
  "task_grant_expiring",
  "task_owner_unavailable",
] as const;

test("task reasons, the task subject kind and the tasks source belong to the published vocabulary", () => {
  for (const reason of TASK_REASONS) expect(ATTENTION_REASONS).toContain(reason);
  expect(ATTENTION_REASONS.filter((reason) => reason.startsWith("task_"))).toEqual([
    ...TASK_REASONS,
  ]);
  expect(ATTENTION_SUBJECT_KINDS).toContain("task");
  expect(ATTENTION_SOURCES).toContain("tasks");
  expect(new Set(ATTENTION_REASONS).size).toBe(ATTENTION_REASONS.length);
  expect(new Set(ATTENTION_SOURCES).size).toBe(ATTENTION_SOURCES.length);
  expect(new Set(ATTENTION_SUBJECT_KINDS).size).toBe(ATTENTION_SUBJECT_KINDS.length);
});

test("task items keep their subject and order by class, deadline and id like every other item", () => {
  const taskItem = (
    reason: (typeof TASK_REASONS)[number],
    overrides: Partial<AttentionItem>,
  ): AttentionItem => ({
    ...item(`task:${reason}`),
    kind: "task",
    subject: { kind: "task", id: reason, name: "Weekly report" },
    reason,
    ...overrides,
  });
  const failed = taskItem("task_run_failed", { class: "failing", severity: "urgent" });
  const ready = taskItem("task_result_ready", {});
  const required = taskItem("task_grant_required", { class: "stopped", severity: "urgent" });
  const expiring = taskItem("task_grant_expiring", { deadline: "2026-11-20T00:00:00.000Z" });
  const ownerGone = taskItem("task_owner_unavailable", {
    class: "stopped",
    severity: "urgent",
    since: "2026-11-18T00:00:00.000Z",
  });
  const projected = projectAttentionItems([ready, expiring, failed, ownerGone, required], false);
  expect(projected.map((entry) => entry.reason)).toEqual([
    "task_owner_unavailable",
    "task_grant_required",
    "task_run_failed",
    "task_grant_expiring",
    "task_result_ready",
  ]);
  expect(projected.every((entry) => entry.subject?.kind === "task")).toBe(true);
  expect(attentionAllClear({ ...empty, items: [ready] })).toBe(false);
  expect(attentionAllClear({ ...empty, sources: { ...sources, tasks: "failed" } })).toBe(false);
  expect(attentionAllClear({ ...empty, sources: { ...sources, tasks: "not_permitted" } })).toBe(
    true,
  );
});

test("a held trigger keeps its own reason and an unknown one asks for approval", () => {
  for (const reason of [
    "execution_authority_required",
    "execution_authority_expired",
    "execution_authority_exhausted",
    "execution_authority_revoked",
    "execution_authority_changed",
    "input_required",
  ] as const)
    expect(heldAttentionReason(reason)).toBe(reason);
  for (const reason of ["failing", "something_new", "", null, undefined])
    expect(heldAttentionReason(reason)).toBe("execution_authority_required");
});

const at = new Date("2026-11-23T10:00:00.000Z");
const later = (ms: number) => new Date(at.getTime() + ms);

test("a snooze has to end in the future and within thirty days", () => {
  expect(planSnooze(later(60_000), at)).toEqual({ ok: true, until: later(60_000) });
  expect(planSnooze(later(SNOOZE_MAX_MS), at)).toEqual({ ok: true, until: later(SNOOZE_MAX_MS) });
  expect(planSnooze(at, at)).toEqual({ ok: false, reason: "snooze_in_past" });
  expect(planSnooze(later(-1), at)).toEqual({ ok: false, reason: "snooze_in_past" });
  expect(planSnooze(new Date(Number.NaN), at)).toEqual({ ok: false, reason: "snooze_in_past" });
  expect(planSnooze(later(SNOOZE_MAX_MS + 1), at)).toEqual({
    ok: false,
    reason: "snooze_too_long",
  });
});

test("the snooze key names id, class and reason", () => {
  expect(attentionSnoozeKey(item("workflow:1"))).toBe("workflow:1|decide|approval_expiring");
});

test("an active snooze moves its item out of the list and keeps the others", () => {
  const split = splitSnoozed(
    [item("a"), item("b"), item("c")],
    [
      { attention_key: "b|decide|approval_expiring", snoozed_until: later(60_000) },
      { attention_key: "missing|decide|approval_expiring", snoozed_until: later(60_000) },
    ],
    at,
  );
  expect(split.items.map((entry) => entry.id)).toEqual(["a", "c"]);
  expect(split.snoozed).toEqual([
    {
      ...item("b"),
      attention_key: "b|decide|approval_expiring",
      snoozed_until: later(60_000).toISOString(),
    },
  ]);
});

test("a snooze that ended, or one for another class or reason, hides nothing", () => {
  const items = [item("a")];
  for (const snooze of [
    { attention_key: "a|decide|approval_expiring", snoozed_until: at },
    { attention_key: "a|decide|approval_expiring", snoozed_until: later(-1) },
    { attention_key: "a|stopped|approval_expiring", snoozed_until: later(60_000) },
    { attention_key: "a|decide|failing", snoozed_until: later(60_000) },
  ])
    expect(splitSnoozed(items, [snooze], at)).toEqual({ items, snoozed: [] });
  expect(splitSnoozed(items, [], at)).toEqual({ items, snoozed: [] });
});
