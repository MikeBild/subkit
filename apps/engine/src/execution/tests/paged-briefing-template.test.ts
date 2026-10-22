import { expect, test } from "bun:test";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import { renderPagedBriefing } from "./paged-briefing-template.ts";

type Row = Record<string, unknown>;
type Envelope = {
  data: unknown;
  status_code?: number;
  duration_ms: number;
  error: { code: string; message: string } | null;
  pagination?: Row;
};
type Completeness = {
  source: string;
  complete: boolean;
  count: number;
  duplicates_dropped: number;
  reason: string | null;
};
type Briefing = {
  repository: { full_name: string };
  changes_since_previous_period: {
    possible_truncation: boolean;
    completeness: Completeness[];
    current: Record<string, number>;
    previous: Record<string, number>;
  };
  release_progress: {
    project: { item_count: number; total_count: number | null; complete: boolean };
    open_tasks_count: number;
  };
  missing_evidence: Array<{ message: string }>;
  prioritized_next_steps: Array<{ source_url: string; priority: string; project_status: string }>;
};

const NOW = "2026-03-10T08:00:00.000Z";
const CURRENT = "2026-03-09T08:00:00.000Z";
const PREVIOUS = "2026-03-08T08:00:00.000Z";
const IN_CURRENT = "2026-03-09T12:00:00.000Z";
const IN_PREVIOUS = "2026-03-08T12:00:00.000Z";
const OLD = "2025-01-01T00:00:00.000Z";
const BASE = "https://github.com/acme/app";
const PAGED = ["commits", "issues", "issues_open", "actions", "milestones", "project_items"];

const EXPRESSION = renderPagedBriefing({
  owner: "acme",
  repository: "app",
  projectUrl: "https://github.com/users/acme/projects/1",
});

const summary = (items: number, overrides: Row = {}) => ({
  pages: 1,
  items,
  duplicates_dropped: 0,
  complete: true,
  truncated: false,
  ...overrides,
});

const read = (data: unknown, pagination?: Row): Envelope => ({
  data,
  status_code: 200,
  duration_ms: 0,
  error: null,
  ...(pagination ? { pagination } : {}),
});

const failed = (code: string): Envelope => ({
  data: null,
  duration_ms: 0,
  error: { code, message: code },
});

const issue = (number: number, fields: Row) => ({
  id: number,
  number,
  title: `Issue ${number}`,
  state: "open",
  created_at: OLD,
  closed_at: null,
  html_url: `${BASE}/issues/${number}`,
  labels: [],
  milestone: null,
  ...fields,
});

const pull = (number: number, fields: Row, mergedAt: string | null) => ({
  ...issue(number, fields),
  title: `Pull ${number}`,
  html_url: `${BASE}/pull/${number}`,
  pull_request: { merged_at: mergedAt },
});

const nested = (nodes: Row[], overrides: Row = {}) => ({
  totalCount: nodes.length,
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
  ...overrides,
});

const projectItem = (number: number, overrides: { labels?: Row; fieldValues?: Row } = {}) => ({
  id: `item-${number}`,
  content: {
    __typename: "Issue",
    number,
    url: `${BASE}/issues/${number}`,
    labels: overrides.labels ?? nested([{ name: "area" }]),
  },
  fieldValues:
    overrides.fieldValues ??
    nested([
      { name: "Todo", field: { name: "Status" } },
      { name: "P1", field: { name: "Priority" } },
    ]),
});

const project = (nodes: Row[], totalCount = nodes.length) => ({
  user: {
    projectV2: {
      items: { totalCount, nodes, pageInfo: { hasNextPage: false, endCursor: null } },
    },
  },
});

function baseScope(): Record<string, Envelope> {
  const issues = [
    issue(1, { created_at: IN_CURRENT }),
    issue(2, { state: "closed", created_at: IN_PREVIOUS, closed_at: IN_CURRENT }),
    pull(3, { state: "closed", created_at: IN_PREVIOUS, closed_at: IN_CURRENT }, IN_PREVIOUS),
    pull(4, { state: "closed", created_at: IN_CURRENT, closed_at: IN_CURRENT }, null),
    pull(5, { created_at: IN_PREVIOUS }, null),
  ];
  const open = [issue(1, { created_at: IN_CURRENT }), issue(6, {}), pull(7, {}, null)];
  const runs = [
    { id: 70, name: "CI", created_at: IN_CURRENT, conclusion: "success" },
    { id: 71, name: "CI", created_at: IN_CURRENT, conclusion: "failure" },
    { id: 72, name: "CI", created_at: IN_PREVIOUS, conclusion: "success" },
  ];
  const nodes = [projectItem(1), projectItem(6)];
  return {
    windows: read({ mode: "daily", now: NOW, current_start: CURRENT, previous_start: PREVIOUS }),
    repo: read({ full_name: "acme/app" }),
    main_ref: read({ object: { sha: "abc123" } }),
    commits: read(
      [
        { sha: "a", commit: { committer: { date: IN_CURRENT } } },
        { sha: "b", commit: { committer: { date: IN_CURRENT } } },
        { sha: "c", commit: { committer: { date: IN_PREVIOUS } } },
      ],
      summary(3),
    ),
    issues: read(issues, summary(issues.length)),
    issues_open: read(open, summary(open.length)),
    actions: read(runs, summary(runs.length)),
    milestones: read(
      [{ id: 900, number: 1, title: "M1", state: "open", open_issues: 1, closed_issues: 3 }],
      summary(1),
    ),
    project_items: read(project(nodes), summary(nodes.length)),
  };
}

async function brief(scope: Record<string, Envelope>): Promise<Briefing> {
  const result = await runJs<Briefing>({
    code: EXPRESSION,
    input: { scope, input: { mode: "daily" } },
    clock: { now_ms: Date.parse(NOW), seed: "paged-briefing-template" },
  });
  return result.output;
}

const entry = (output: Briefing, source: string) =>
  output.changes_since_previous_period.completeness.find((item) => item.source === source);

test("a complete read reports every source complete with deduplicated counts", async () => {
  const output = await brief(baseScope());
  const changes = output.changes_since_previous_period;
  expect(output.repository.full_name).toBe("acme/app");
  expect(changes.possible_truncation).toBe(false);
  expect(changes.completeness).toEqual([
    { source: "repo", complete: true, count: 1, duplicates_dropped: 0, reason: null },
    { source: "main_ref", complete: true, count: 1, duplicates_dropped: 0, reason: null },
    { source: "commits", complete: true, count: 3, duplicates_dropped: 0, reason: null },
    { source: "issues", complete: true, count: 5, duplicates_dropped: 0, reason: null },
    { source: "issues_open", complete: true, count: 3, duplicates_dropped: 0, reason: null },
    { source: "actions", complete: true, count: 3, duplicates_dropped: 0, reason: null },
    { source: "milestones", complete: true, count: 1, duplicates_dropped: 0, reason: null },
    { source: "project_items", complete: true, count: 2, duplicates_dropped: 0, reason: null },
  ]);
  expect(output.release_progress.project).toMatchObject({
    item_count: 2,
    total_count: 2,
    complete: true,
  });
  expect(output.missing_evidence.some((item) => item.message.startsWith("Quelle"))).toBe(false);
  expect(await brief(baseScope())).toEqual(output);
});

test("issues and open issues are merged once and pull requests are counted apart", async () => {
  const output = await brief(baseScope());
  expect(output.release_progress.open_tasks_count).toBe(2);
  expect(output.prioritized_next_steps.map((step) => step.source_url)).toEqual([
    `${BASE}/issues/1`,
    `${BASE}/issues/6`,
  ]);
  expect(output.prioritized_next_steps[0]).toMatchObject({
    priority: "P1",
    project_status: "Todo",
  });
  expect(output.changes_since_previous_period.current).toMatchObject({
    issues_opened: 1,
    issues_completed: 1,
    pulls_opened: 1,
    pulls_completed: 1,
    commits: 2,
    workflow_runs: 2,
    successful_runs: 1,
    failed_runs: 1,
  });
  expect(output.changes_since_previous_period.previous).toMatchObject({
    issues_opened: 1,
    issues_completed: 0,
    pulls_opened: 2,
    pulls_completed: 1,
    commits: 1,
    workflow_runs: 1,
  });
});

test("a merged pull request completes when merged and a closed one when closed", async () => {
  const scope = baseScope();
  const rows = [
    pull(10, { state: "closed", created_at: OLD, closed_at: IN_CURRENT }, IN_PREVIOUS),
    pull(11, { state: "closed", created_at: OLD, closed_at: IN_CURRENT }, null),
    pull(12, { state: "closed", created_at: OLD, closed_at: IN_PREVIOUS }, null),
  ];
  scope.issues = read(rows, summary(rows.length));
  scope.issues_open = read([], summary(0));
  const output = await brief(scope);
  expect(output.changes_since_previous_period.current.pulls_completed).toBe(1);
  expect(output.changes_since_previous_period.previous.pulls_completed).toBe(2);
  expect(output.changes_since_previous_period.current.issues_completed).toBe(0);
});

test("second-precision provider timestamps fall into the half-open window of their instant", async () => {
  const scope = baseScope();
  scope.windows = read({
    mode: "daily",
    now: "2026-03-10T08:00:00.500Z",
    current_start: "2026-03-09T08:00:00.500Z",
    previous_start: "2026-03-08T08:00:00.500Z",
  });
  const rows = [
    issue(20, { created_at: "2026-03-10T08:00:00Z" }),
    issue(21, { created_at: "2026-03-09T08:00:00Z" }),
    issue(22, { created_at: "2026-03-08T08:00:00Z" }),
    issue(23, { state: "closed", created_at: OLD, closed_at: "2026-03-10T08:00:00Z" }),
  ];
  scope.issues = read(rows, summary(rows.length));
  scope.issues_open = read([], summary(0));
  scope.commits = read(
    [
      { sha: "d", commit: { committer: { date: "2026-03-10T08:00:00Z" } } },
      { sha: "e", commit: { committer: { date: "2026-03-09T08:00:00Z" } } },
      { sha: "f", commit: { committer: { date: "2026-03-08T08:00:00Z" } } },
    ],
    summary(3),
  );
  scope.actions = read([], summary(0));
  const output = await brief(scope);
  expect(output.changes_since_previous_period.current).toMatchObject({
    issues_opened: 1,
    issues_completed: 1,
    commits: 1,
  });
  expect(output.changes_since_previous_period.previous).toMatchObject({
    issues_opened: 1,
    issues_completed: 0,
    commits: 1,
  });
});

test.each(PAGED)(
  "a paged %s read without a pagination summary is never reported complete",
  async (source) => {
    const scope = baseScope();
    const { pagination: _pagination, ...withoutSummary } = scope[source] as Envelope;
    scope[source] = withoutSummary;
    const output = await brief(scope);
    expect(entry(output, source)).toMatchObject({ complete: false, reason: "unverified" });
    expect(output.changes_since_previous_period.possible_truncation).toBe(true);
    expect(output.missing_evidence.map((item) => item.message)).toContain(
      `Quelle unvollständig gelesen: ${source} (Vollständigkeit vom Abruf nicht bestätigt).`,
    );
  },
);

test("single-resource reads stay complete without a pagination summary", async () => {
  const output = await brief(baseScope());
  expect(entry(output, "repo")).toMatchObject({ complete: true, reason: null });
  expect(entry(output, "main_ref")).toMatchObject({ complete: true, reason: null });
});

test("a truncated, an incomplete and a deduplicated read keep their reasons", async () => {
  const scope = baseScope();
  scope.commits = read(
    (scope.commits as Envelope).data,
    summary(3, { complete: false, truncated: true }),
  );
  scope.actions = read((scope.actions as Envelope).data, summary(3, { complete: false }));
  scope.issues = read((scope.issues as Envelope).data, summary(5, { duplicates_dropped: 2 }));
  const output = await brief(scope);
  expect(entry(output, "commits")).toEqual({
    source: "commits",
    complete: false,
    count: 3,
    duplicates_dropped: 0,
    reason: "limit_reached",
  });
  expect(entry(output, "actions")).toMatchObject({ complete: false, reason: "incomplete" });
  expect(entry(output, "issues")).toEqual({
    source: "issues",
    complete: true,
    count: 5,
    duplicates_dropped: 2,
    reason: null,
  });
  expect(output.changes_since_previous_period.possible_truncation).toBe(true);
});

test("failed sources are reported as rate limited, incomplete or unavailable", async () => {
  const scope = baseScope();
  scope.actions = failed("upstream_rate_limited");
  scope.commits = failed("pagination_link_foreign");
  scope.milestones = failed("http_error");
  const output = await brief(scope);
  expect(entry(output, "actions")).toMatchObject({
    complete: false,
    count: 0,
    reason: "rate_limited",
  });
  expect(entry(output, "commits")).toMatchObject({
    complete: false,
    count: 0,
    reason: "incomplete",
  });
  expect(entry(output, "milestones")).toMatchObject({
    complete: false,
    count: 0,
    reason: "not_available",
  });
  expect(output.missing_evidence.map((item) => item.message)).toEqual(
    expect.arrayContaining([
      "Quelle nicht verfügbar: actions (Abrufgrenze des Anbieters erreicht; nach dem Zurücksetzen erneut ausführen).",
      "Quelle unvollständig gelesen: commits (Seiten oder Verbindungen unvollständig).",
      "Quelle nicht verfügbar: milestones (http_error).",
    ]),
  );
});

const projectCases: Array<[string, (scope: Record<string, Envelope>) => void]> = [
  [
    "fewer items than the declared total",
    (scope) => {
      scope.project_items = read(project([projectItem(1)], 2), summary(1));
    },
  ],
  [
    "an incomplete project read",
    (scope) => {
      scope.project_items = read(
        project([projectItem(1), projectItem(6)]),
        summary(2, { complete: false }),
      );
    },
  ],
  [
    "labels beyond the first page",
    (scope) => {
      const labels = nested([{ name: "area" }], {
        pageInfo: { hasNextPage: true, endCursor: "next" },
      });
      scope.project_items = read(project([projectItem(1, { labels }), projectItem(6)]), summary(2));
    },
  ],
  [
    "labels fewer than their total",
    (scope) => {
      const labels = nested([{ name: "area" }], { totalCount: 21 });
      scope.project_items = read(project([projectItem(1), projectItem(6, { labels })]), summary(2));
    },
  ],
  [
    "field values beyond the first page",
    (scope) => {
      const fieldValues = nested([{ name: "Todo", field: { name: "Status" } }], {
        pageInfo: { hasNextPage: true, endCursor: "next" },
      });
      scope.project_items = read(
        project([projectItem(1, { fieldValues }), projectItem(6)]),
        summary(2),
      );
    },
  ],
  [
    "field values fewer than their total",
    (scope) => {
      const fieldValues = nested([{ name: "Todo", field: { name: "Status" } }], { totalCount: 51 });
      scope.project_items = read(
        project([projectItem(1), projectItem(6, { fieldValues })]),
        summary(2),
      );
    },
  ],
];

test.each(projectCases)("project items with %s are reported incomplete", async (_label, mutate) => {
  const scope = baseScope();
  mutate(scope);
  const output = await brief(scope);
  expect(entry(output, "project_items")).toMatchObject({ complete: false, reason: "incomplete" });
  expect(output.release_progress.project.complete).toBe(false);
  expect(output.changes_since_previous_period.possible_truncation).toBe(true);
  expect(output.missing_evidence.map((item) => item.message)).toContain(
    "Quelle unvollständig gelesen: project_items (Seiten oder Verbindungen unvollständig).",
  );
});

test("a failed project read keeps no totals and reports the source incomplete", async () => {
  const scope = baseScope();
  scope.project_items = failed("graphql_pagination_incomplete");
  const output = await brief(scope);
  expect(entry(output, "project_items")).toEqual({
    source: "project_items",
    complete: false,
    count: 0,
    duplicates_dropped: 0,
    reason: "incomplete",
  });
  expect(output.release_progress.project).toMatchObject({
    item_count: 0,
    total_count: null,
    complete: false,
  });
});
