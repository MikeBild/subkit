import { expect, test } from "bun:test";
import fc from "fast-check";
import type { AttentionItem, AttentionV1 } from "./attention.ts";
import {
  attentionHeadline,
  attentionLine,
  type DigestFailureGroup,
  type FailedExecutionFact,
  type FailedStepFact,
  failingScheduledGroups,
  groupFailureFacts,
  projectPendingPatches,
  renderDigest,
} from "./health-digest.ts";

const SOURCES: AttentionV1["sources"] = {
  conversations: "answered",
  schedules: "answered",
  freshness: "answered",
  failures: "answered",
  patches: "answered",
  connectors: "answered",
  connections: "answered",
  secret_approvals: "answered",
  skills: "answered",
  intake: "answered",
  budget: "answered",
  ai_access: "answered",
  risk: "answered",
  tasks: "answered",
};

function attention(items: AttentionItem[] = []): AttentionV1 {
  return {
    schema_version: "attention.v1",
    generated_at: "2026-11-09T00:00:00.000Z",
    sources: { ...SOURCES },
    status: null,
    items,
  };
}

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "item",
    class: "failing",
    severity: "urgent",
    kind: "workflow",
    subject: { kind: "workflow", id: "wf", name: "Daily" },
    reason: "failing",
    trigger: null,
    cause_class: null,
    counts: {},
    since: null,
    deadline: null,
    detail: null,
    actions: [],
    ...overrides,
  };
}

function execution(overrides: Partial<FailedExecutionFact> = {}): FailedExecutionFact {
  return {
    id: "one",
    workflow_id: "wf",
    source_kind: "saved",
    source_ref: null,
    request_source: "scheduler",
    created_at: new Date("2026-11-01T10:00:00.000Z"),
    status: "failed",
    failure: { step_id: "fetch", error_code: "http_4xx", error_message: "not found" },
    ...overrides,
  };
}

function step(overrides: Partial<FailedStepFact> = {}): FailedStepFact {
  return {
    execution_id: "one",
    step_key: "fetch",
    status: "failed",
    error: { code: "http_4xx", message: "not found", guidance: "Check the path." },
    started_at: new Date("2026-11-01T10:00:00.000Z"),
    request_meta: { connector: { connector_id: "connector" } },
    ...overrides,
  };
}

test("groups stopping failures by signature, preserves first/last and merges origins", () => {
  const executions = Object.freeze([
    Object.freeze(execution()),
    Object.freeze(execution({ id: "two", created_at: new Date("2026-11-03T10:00:00.000Z") })),
    Object.freeze(
      execution({
        id: "three",
        request_source: "cli",
        created_at: new Date("2026-11-02T10:00:00.000Z"),
      }),
    ),
    Object.freeze(
      execution({
        id: "draft",
        workflow_id: null,
        source_kind: "draft",
        source_ref: { name: "Untitled draft" },
        request_source: "chat",
        status: "timed_out",
        failure: null,
      }),
    ),
    Object.freeze(execution({ id: "fallback", failure: null, request_source: "api" })),
  ]);
  const steps = Object.freeze([
    Object.freeze(step()),
    Object.freeze(step({ execution_id: "two" })),
    Object.freeze(step({ execution_id: "three" })),
    Object.freeze(
      step({
        execution_id: "draft",
        step_key: "transform",
        status: "timed_out",
        error: { code: "timeout", message: "too slow" },
        request_meta: { connector: { connector_id: "" } },
      }),
    ),
  ]);
  const before = JSON.stringify({ executions, steps });

  const groups = groupFailureFacts(executions, steps);
  const merged = groups.get("wf:fetch:http_4xx");
  expect(merged).toMatchObject({
    count: 3,
    scheduled_count: 2,
    origin: "mixed",
    first_seen: "2026-11-01T10:00:00.000Z",
    last_seen: "2026-11-03T10:00:00.000Z",
    latest_execution_id: "one",
    connector_id: "connector",
    cause: "Check the path.",
    guidance: "Check the path.",
  });
  expect(groups.get("draft:transform:timeout")).toMatchObject({
    workflow_name: "Untitled draft",
    origin: "authoring",
    connector_id: null,
    cause_class: "timeout",
  });
  expect(groups.get("wf:-:-")).toMatchObject({
    origin: "manual",
    error_code: null,
    cause_class: "driver_error",
  });
  expect(failingScheduledGroups([...groups.values()])).toEqual([merged!]);
  expect(JSON.stringify({ executions, steps })).toBe(before);
});

test("headline, item and digest rendering preserve labels, null fields and detailed counts", () => {
  const rich = item({
    class: "stopped",
    subject: { kind: "connector", id: "conn", name: null },
    reason: "execution_authority_required",
    counts: {
      failures: 1,
      patches: 2,
      skills: 1,
      intake: 2,
      intake_by_category: [
        { category: "alpha", count: 1 },
        { category: "beta", count: 2 },
        { category: "gamma", count: 3 },
        { category: "delta", count: 4 },
      ],
      intake_categories_omitted: 5,
    },
    approval: { version: 3, environment: "prod" },
    repair: {
      step_id: "get_user",
      code: "http_404",
      remedy_kind: "reconnect",
      steps: 2,
      candidate_id: null,
      execution_id: null,
    },
    detail: "Needs a decision",
  });
  const noSubject = item({ id: "other", class: "decide", subject: null, kind: "budget" });
  const view = attention([rich, noSubject]);
  view.sources.connectors = "failed";

  expect(attentionHeadline(attention())).toBe("All clear — nothing needs your attention.");
  expect(attentionHeadline({ ...attention(), sources: { ...SOURCES, risk: "failed" } })).toBe(
    "Nothing needs your attention in what could be read. Could not read: risk.",
  );
  expect(attentionHeadline(view)).toBe(
    "Needs attention: 2 items (1 stopped, 1 to decide). Could not read: connectors.",
  );
  expect(attentionLine(rich)).toBe(
    '- [stopped] connector "conn": execution authority required (1 failure, 2 fixes, 1 skill proposal, 2 collected items to review, by category: alpha 1 | beta 2 | gamma 3 | other 9, v3, prod, step "get_user" http 404, 2 steps blocked, remedy: reconnect) — Needs a decision',
  );
  expect(attentionLine(noSubject)).toBe("- [decide] budget: failing");

  const group: DigestFailureGroup = {
    signature: "wf:fetch:http_4xx",
    workflow_id: "wf",
    workflow_name: null,
    step_key: "fetch",
    error_code: "http_4xx",
    origin: "scheduled",
    count: 2,
    scheduled_count: 2,
    first_seen: "2026-11-01T10:00:00.000Z",
    last_seen: "2026-11-03T10:00:00.000Z",
    latest_execution_id: "two",
    connector_id: null,
    resolved_at: "2026-11-04T10:00:00.000Z",
    cause: "Check the path.",
    cause_class: "driver_error",
    guidance: null,
  };
  const risk = {
    kind: "pool_saturation",
    severity: "critical" as const,
    headline: "Pool full",
    detail: "Workers queue",
    metric: "pool",
    value: 1,
    threshold: 0,
  };
  expect(renderDigest("All clear", 24, attention(), [], [])).toBe("All clear");
  expect(renderDigest("Headline", 24, view, [group], [risk])).toBe(
    [
      "Headline",
      "",
      attentionLine(rich),
      attentionLine(noSubject),
      "",
      "Risk signals (leading indicators):",
      "[critical] Pool full",
      "   Workers queue",
      "",
      "Failed runs in the last 24h, by cause:",
      "[scheduled] wf — failed 2× (last 2026-11-03T10:00:00.000Z)",
      "   Check the path.",
      "   last ran clean on its schedule 2026-11-04T10:00:00.000Z",
      "",
      "Ask me to walk through any of these.",
    ].join("\n"),
  );
});

test("pending patches retain original facts, use description fallback and order by age then unsafe", () => {
  const now = Date.parse("2026-11-09T00:00:00.000Z");
  const rows = Object.freeze([
    Object.freeze({
      id: "safe-old",
      workflow_id: "a",
      classification: "safe" as const,
      created_at: new Date(now - 3 * 86_400_000),
      diff: { proposal: { description: "Old safe" } },
    }),
    Object.freeze({
      id: "unsafe-old",
      workflow_id: "b",
      classification: "unsafe" as const,
      created_at: new Date(now - 3 * 86_400_000),
      diff: { proposal: {} },
    }),
    Object.freeze({
      id: "fresh",
      workflow_id: "missing",
      classification: "safe" as const,
      created_at: new Date(now - 86_400_000 + 1),
      diff: null,
    }),
  ]);
  const before = JSON.stringify(rows);
  expect(
    projectPendingPatches(
      rows,
      new Map([
        ["a", "Alpha"],
        ["b", "Beta"],
      ]),
      now,
    ),
  ).toEqual([
    {
      id: "unsafe-old",
      workflow_id: "b",
      workflow_name: "Beta",
      classification: "unsafe",
      age_days: 3,
      stuck: true,
      summary: "Self-healing fix awaiting review",
    },
    {
      id: "safe-old",
      workflow_id: "a",
      workflow_name: "Alpha",
      classification: "safe",
      age_days: 3,
      stuck: true,
      summary: "Old safe",
    },
    {
      id: "fresh",
      workflow_id: "missing",
      workflow_name: null,
      classification: "safe",
      age_days: 0,
      stuck: false,
      summary: "Self-healing fix awaiting review",
    },
  ]);
  expect(JSON.stringify(rows)).toBe(before);
});

test("pure projection is deterministic and never mutates frozen patch facts", () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 10 }), { maxLength: 20 }), (ages) => {
      const now = Date.parse("2026-11-09T00:00:00.000Z");
      const rows = Object.freeze(
        ages.map((age, index) =>
          Object.freeze({
            id: `id-${index}`,
            workflow_id: `wf-${index}`,
            classification: index % 2 === 0 ? ("safe" as const) : ("unsafe" as const),
            created_at: new Date(now - age * 86_400_000),
            diff: { proposal: { description: `Patch ${index}` } },
          }),
        ),
      );
      const before = JSON.stringify(rows);
      const first = projectPendingPatches(rows, new Map(), now);
      expect(projectPendingPatches(rows, new Map(), now)).toEqual(first);
      expect(JSON.stringify(rows)).toBe(before);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});

test("single failing item headline and count variants remain readable without unread sources", () => {
  expect(attentionHeadline(attention([item()]))).toBe("Needs attention: 1 item (1 failing).");
  expect(
    attentionHeadline({
      ...attention([item()]),
      sources: { ...SOURCES, risk: "failed", budget: "failed" },
    }),
  ).toBe("Needs attention: 1 item (1 failing). Could not read: budget, risk.");
  expect(
    attentionLine(
      item({
        counts: {
          failures: 2,
          patches: 1,
          skills: 2,
          intake: 1,
          intake_by_category: [{ category: "research", count: 1 }],
        },
      }),
    ),
  ).toBe(
    '- [failing] workflow "Daily": failing (2 failures, 1 fix, 2 skill proposals, 1 collected item to review, by category: research 1)',
  );
  expect(
    attentionLine(
      item({
        repair: {
          step_id: "fetch",
          code: null,
          remedy_kind: "patch",
          steps: 1,
          candidate_id: null,
          execution_id: null,
        },
      }),
    ),
  ).toBe('- [failing] workflow "Daily": failing (step "fetch", remedy: patch)');
});

test("digest renders each independent section without empty unrelated headings", () => {
  expect(renderDigest("Headline", 12, attention([item()]), [], [])).toBe(
    'Headline\n\n- [failing] workflow "Daily": failing\n\nAsk me to walk through any of these.',
  );
  expect(
    renderDigest(
      "Headline",
      12,
      attention(),
      [],
      [
        {
          kind: "pool",
          severity: "warn",
          headline: "Queue rising",
          detail: "Inspect workers",
          metric: "queue",
          value: 2,
          threshold: 1,
        },
      ],
    ),
  ).toBe(
    "Headline\n\nRisk signals (leading indicators):\n[warn] Queue rising\n   Inspect workers\n\nAsk me to walk through any of these.",
  );
  const groups = [
    ...groupFailureFacts(
      [execution({ workflow_id: null, source_kind: "draft", failure: null })],
      [],
    ).values(),
  ];
  for (const origin of ["authoring", "manual", "mixed"] as const) {
    expect(renderDigest("Headline", 12, attention(), [{ ...groups[0]!, origin }], [])).toBe(
      `Headline\n\nFailed runs in the last 12h, by cause:\n[${origin}] (draft) — failed once (last 2026-11-01T10:00:00.000Z)\n   The step driver failed: \n\nAsk me to walk through any of these.`,
    );
  }
});

test("failure groups retain earliest observations and consistent scheduled origin", () => {
  const groups = [
    ...groupFailureFacts(
      [
        execution({ id: "new", created_at: new Date("2026-11-03T10:00:00Z") }),
        execution({ id: "old", created_at: new Date("2026-11-01T10:00:00Z") }),
        execution({ id: "mid", created_at: new Date("2026-11-02T10:00:00Z") }),
      ],
      [step({ execution_id: "new" }), step({ execution_id: "old" }), step({ execution_id: "mid" })],
    ).values(),
  ];
  expect(groups[0]).toMatchObject({
    workflow_id: "wf",
    origin: "scheduled",
    count: 3,
    scheduled_count: 3,
    first_seen: "2026-11-01T10:00:00.000Z",
    last_seen: "2026-11-03T10:00:00.000Z",
  });
  expect(failingScheduledGroups([{ ...groups[0]!, resolved_at: "2026-11-04T00:00:00Z" }])).toEqual(
    [],
  );
  const saved = [
    ...groupFailureFacts(
      [execution({ source_ref: { name: "Ignored saved alias" }, failure: null })],
      [],
    ).values(),
  ][0]!;
  expect(saved.workflow_name).toBeNull();
  const authored = [
    ...groupFailureFacts(
      [execution({ workflow_id: null, source_kind: "step", failure: null })],
      [],
    ).values(),
  ][0]!;
  expect(authored.origin).toBe("authoring");
});

test("failure causes use stopping-step status and execution status when no step exists", () => {
  const fromStep = [
    ...groupFailureFacts(
      [execution()],
      [step({ status: "timed_out", error: { code: "timeout", message: "timed out" } })],
    ).values(),
  ][0]!;
  expect(fromStep.cause).toBe("The timed_out step exceeded its timeout.");
  const noStep = [
    ...groupFailureFacts([execution({ status: "timed_out", failure: null })], []).values(),
  ][0]!;
  expect(noStep.cause).toBe("The step step exceeded its timeout.");
  const callable = function Callable() {};
  const untrusted = [
    ...groupFailureFacts(
      [execution({ workflow_id: null, source_ref: callable, failure: null })],
      [],
    ).values(),
  ][0]!;
  expect(untrusted.workflow_name).toBeNull();
});

test("patches with equal age preserve peers and prioritize unsafe entries in either input order", () => {
  const created_at = new Date("2026-11-01T00:00:00Z");
  const rows = [
    { id: "unsafe", workflow_id: "wf", classification: "unsafe" as const, created_at, diff: {} },
    { id: "safe1", workflow_id: "wf", classification: "safe" as const, created_at, diff: {} },
    { id: "safe2", workflow_id: "wf", classification: "safe" as const, created_at, diff: {} },
  ];
  expect(projectPendingPatches(rows, new Map(), created_at.getTime()).map((row) => row.id)).toEqual(
    ["unsafe", "safe1", "safe2"],
  );
  expect(
    projectPendingPatches([...rows].reverse(), new Map(), created_at.getTime()).map(
      (row) => row.id,
    ),
  ).toEqual(["unsafe", "safe2", "safe1"]);
});

test("unsafe patches with equal age preserve their input order", () => {
  const created_at = new Date("2026-11-01T00:00:00Z");
  const rows = ["first", "second"].map((id) => ({
    id,
    workflow_id: "wf",
    classification: "unsafe" as const,
    created_at,
    diff: {},
  }));
  expect(projectPendingPatches(rows, new Map(), created_at.getTime()).map((row) => row.id)).toEqual(
    ["first", "second"],
  );
});
