import { expect, test } from "bun:test";
import {
  authorityIssues,
  authorityProblems,
  refusalSentenceKey,
  unavailableSteps,
} from "@/features/grants/model/authority-issues";
import { CATALOGS, translate } from "@/lib/i18n";

type Preview = Parameters<typeof authorityIssues>[0];

const preview = (over: Record<string, unknown>) =>
  ({
    manifest: { issues: [], effects: [] },
    unavailable_steps: [],
    ...over,
  }) as unknown as Preview;

test("every issue becomes a sentence tied to its step", () => {
  const issues = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [
          { step_id: "store_manifest", code: "boundary_contradicted_by_history" },
          { step_id: "send", code: "dynamic_request" },
        ],
      },
    }),
  );
  expect(issues.map((i) => [i.step_id, i.messageKey])).toEqual([
    ["store_manifest", "authority.issue.boundary_contradicted_by_history"],
    ["send", "authority.issue.dynamic_request"],
  ]);
  expect(issues.every((i) => i.call_step_id === null)).toBe(true);
});

test("a contradicted folder carries the two values that make it actionable", () => {
  const [issue] = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [{ step_id: "store_manifest", code: "boundary_contradicted_by_history" }],
      },
      boundary_contradictions: [
        {
          step_id: "store_manifest",
          declared_prefix: "v1/latest/",
          observed_key: "v1/infrastructure/manifests/year=2026/month=09/day=10/e9d904a6.json",
          observed_at: "2026-09-10T07:55:00.000Z",
        },
      ],
    }),
  );
  expect(issue?.evidence).toEqual({
    declared_prefix: "v1/latest/",
    observed_key: "v1/infrastructure/manifests/year=2026/month=09/day=10/e9d904a6.json",
  });
});

test("evidence is attached only to the issue it explains", () => {
  const issues = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [
          { step_id: "store_manifest", code: "dynamic_request" },
          { step_id: "other", code: "boundary_contradicted_by_history" },
        ],
      },
      boundary_contradictions: [
        {
          step_id: "store_manifest",
          declared_prefix: "v1/latest/",
          observed_key: "v1/elsewhere/a.json",
          observed_at: "2026-09-10T07:55:00.000Z",
        },
      ],
    }),
  );
  expect(issues[0]?.evidence).toBeUndefined();
  expect(issues[1]?.evidence).toBeUndefined();
  expect(issues[1]?.messageKey).toBe("authority.issue.boundary_contradicted_by_history");
});

test("an issue inside a called workflow says which step started it", () => {
  const [issue] = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [{ step_id: "publish", code: "dynamic_request", call_path: ["run_child"] }],
      },
    }),
  );
  expect(issue?.call_step_id).toBe("run_child");
});

test("a parent and a child sharing a step id and code stay two reasons", () => {
  const issues = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [
          { step_id: "publish", code: "dynamic_request" },
          { step_id: "publish", code: "dynamic_request", call_path: ["run_child"] },
        ],
      },
    }),
  );
  expect(issues).toHaveLength(2);
  expect(issues[0]?.key).not.toBe(issues[1]?.key);
});

test("nothing to report is an empty list, never a placeholder", () => {
  expect(authorityIssues(preview({}))).toEqual([]);
  expect(authorityIssues(null)).toEqual([]);
});

test("the engine's own reason replaces the blanket code", () => {
  const [issue] = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [{ step_id: "send_reminder", code: "dynamic_request" }],
      },
      request_refusals: [{ step_id: "send_reminder", reason: "stricter_profile_applies" }],
    }),
  );
  expect(issue?.reasonKey).toBe("authority.refusal.stricter_profile_applies");
  expect(issue?.code).toBe("dynamic_request");
});

test("a storage refusal is read from its own list", () => {
  const [issue] = authorityIssues(
    preview({
      manifest: { effects: [], issues: [{ step_id: "store_report", code: "dynamic_request" }] },
      storage_refusals: [{ step_id: "store_report", reason: "no_scope" }],
    }),
  );
  expect(issue?.reasonKey).toBe("authority.refusal.no_scope");
});

test("a refusal for a different step is not borrowed", () => {
  const issues = authorityIssues(
    preview({
      manifest: {
        effects: [],
        issues: [
          { step_id: "fetch", code: "dynamic_request" },
          { step_id: "fetch", code: "dynamic_request", call_path: ["call_child"] },
        ],
      },
      request_refusals: [
        { step_id: "fetch", reason: "no_boundary" },
        { step_id: "fetch", reason: "connector_query_conflict", call_path: ["call_child"] },
      ],
    }),
  );
  expect(issues.map((i) => i.reasonKey)).toEqual([
    "authority.refusal.no_boundary",
    "authority.refusal.connector_query_conflict",
  ]);
});

test("a reason we have no sentence for falls back rather than printing an identifier", () => {
  const [issue] = authorityIssues(
    preview({
      manifest: { effects: [], issues: [{ step_id: "a", code: "dynamic_request" }] },
      request_refusals: [{ step_id: "a", reason: "some_future_code" }],
    }),
  );
  expect(issue?.reasonKey).toBeUndefined();
  expect(issue?.messageKey).toBe("authority.issue.dynamic_request");
});

test("a step that pages inside its content has a sentence of its own", () => {
  const [issue] = authorityIssues(
    preview({
      manifest: { effects: [], issues: [{ step_id: "read_all", code: "dynamic_request" }] },
      request_refusals: [{ step_id: "read_all", reason: "pagination_unsupported" }],
    }),
  );
  expect(issue?.reasonKey).toBe("authority.refusal.pagination_unsupported");
});

test("every refusal the engine can name for a request or a tool call has a sentence in both languages", () => {
  const codes = [
    "connector_query_conflict",
    "connector_query_unresolved",
    "connector_query_needs_boundary",
    "pagination_unsupported",
    "pagination_body_unsupported",
    "mcp_not_a_tool_call",
    "mcp_no_boundary",
    "mcp_boundary_invalid",
    "mcp_tool_not_literal",
    "mcp_server_unresolved",
    "mcp_runtime_value_outside_arguments",
    "mcp_argument_placeholder_unsupported",
    "mcp_variables_mismatch",
    "mcp_caller_bound_mismatch",
    "mcp_write_needs_single_attempt",
    "mcp_tool_changed",
    "mcp_tool_unavailable",
  ];
  for (const code of codes) {
    const key = refusalSentenceKey(code);
    expect(key, code).toBe(`authority.refusal.${code}` as typeof key);
    for (const catalog of Object.values(CATALOGS)) {
      const text = (catalog as Record<string, string>)[key ?? ""] ?? "";
      expect(text.length, code).toBeGreaterThan(20);
      expect(text.match(/[.?](?=\s|$)/g) ?? [], code).toHaveLength(1);
    }
  }
  expect(refusalSentenceKey("connector_adds_query")).toBeUndefined();
});

test("a tool call that could not be compared says why instead of only that it is unavailable", () => {
  expect(
    unavailableSteps(
      preview({
        unavailable_steps: ["call", "other", "start_child"],
        request_refusals: [
          { step_id: "call", reason: "mcp_tool_changed" },
          { step_id: "lookup", reason: "mcp_tool_unavailable", call_path: ["start_child"] },
          { step_id: "elsewhere", reason: "mcp_tool_changed", call_path: ["another"] },
        ],
      }),
    ),
  ).toEqual([
    { step_id: "call", inner_step_id: null, reasonKey: "authority.refusal.mcp_tool_changed" },
    { step_id: "other", inner_step_id: null },
    {
      step_id: "start_child",
      inner_step_id: "lookup",
      reasonKey: "authority.refusal.mcp_tool_unavailable",
    },
  ]);
});

test("an unavailable step whose issue already carries the reason does not repeat it", () => {
  expect(
    unavailableSteps(
      preview({
        manifest: { effects: [], issues: [{ step_id: "call", code: "dynamic_request" }] },
        unavailable_steps: ["call"],
        request_refusals: [{ step_id: "call", reason: "mcp_tool_changed" }],
      }),
    ),
  ).toEqual([{ step_id: "call", inner_step_id: null }]);
  expect(unavailableSteps(null)).toEqual([]);
  expect(
    unavailableSteps(
      preview({
        unavailable_steps: ["call"],
        request_refusals: [{ step_id: "call", reason: "not_a_known_reason" }],
      }),
    ),
  ).toEqual([{ step_id: "call", inner_step_id: null }]);
});

test("the sentences shown for a refused version name the step, its reason and the evidence", () => {
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate("de", key, values);
  const lines = authorityProblems(
    preview({
      manifest: {
        effects: [],
        issues: [
          { step_id: "store", code: "boundary_contradicted_by_history" },
          { step_id: "send", code: "dynamic_request", call_path: ["start_child"] },
        ],
      },
      boundary_contradictions: [
        { step_id: "store", declared_prefix: "reports/", observed_key: "tmp/a.csv" },
      ],
      unavailable_steps: ["lookup", "other"],
      request_refusals: [{ step_id: "lookup", reason: "mcp_tool_changed" }],
    }),
    t,
  );
  expect(lines).toHaveLength(4);
  expect(lines[0]).toStartWith("Schritt store: ");
  expect(lines[0]).toContain("reports/");
  expect(lines[0]).toContain("tmp/a.csv");
  expect(lines[1]).toStartWith("Schritt send, im Workflow, den start_child startet: ");
  expect(lines[2]).toBe(`Schritt lookup: ${CATALOGS.de["authority.refusal.mcp_tool_changed"]}`);
  expect(lines[3]).toBe("Schritt other ließ sich gar nicht vorbereiten.");
  expect(authorityProblems(null, t)).toEqual([]);
});

test("a device step the device has not allowed is unavailable without naming the item", () => {
  const device = { device_id: "d", capability: "files" };
  const lines = authorityProblems(
    preview({
      manifest: {
        issues: [],
        effects: [
          { step_id: "save", device },
          { step_id: "plain", target: "https://api.example" },
        ],
      },
      unavailable_steps: ["save", "plain"],
    }),
    (key, values) => translate("de", key, values),
  );
  expect(lines).toEqual([
    `Schritt save: ${CATALOGS.de["authority.refusal.device_not_allowed"]}`,
    "Schritt plain ließ sich gar nicht vorbereiten.",
  ]);
  expect(
    unavailableSteps(
      preview({
        manifest: { issues: [], effects: [{ step_id: "save", device }] },
        unavailable_steps: ["save"],
        request_refusals: [{ step_id: "save", reason: "target_unresolved" }],
      }),
    ),
  ).toEqual([
    { step_id: "save", inner_step_id: null, reasonKey: "authority.refusal.target_unresolved" },
  ]);
});
