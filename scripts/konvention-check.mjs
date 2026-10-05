import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ALL_ROUTE_PATHS } from "../apps/cockpit/src/app/route-table.ts";
import { CATALOGS, interpolate } from "../apps/cockpit/src/lib/i18n.ts";
import { IDENTITY_META, standAt } from "./lib/cockpit-identity.mjs";
import { textOutsidePayloads } from "./lib/cockpit-visible-uuids.mjs";

const KONVENTION_VERSION = "2.3";

let konventionVersionImRepo = null;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const previewPort = Number(process.env.COCKPIT_PREVIEW_PORT || 4176);
const externalBaseUrl = process.env.COCKPIT_BASE_URL?.replace(/\/$/, "");
const baseUrl = externalBaseUrl || `http://127.0.0.1:${previewPort}`;

const ROUTES = ALL_ROUTE_PATHS.map((path) => path.replace(/^\//, ""));

function concreteRoute(route) {
  return route.replace("$conversationId", ID).replace("$resourceId", ID);
}

const MOUNT_MARKERS = {
  "": '[data-testid="attention-page"]',
  decisions: '[data-testid="attention-page"]',
  operations: '[data-testid="attention-page"]',
  chat: '[data-testid="chat-workspace"]',
  "chat/new": '[data-testid="chat-workspace"]',
  "chat/$conversationId": '[data-testid="chat-workspace"]',
  people: '[data-testid="admin-people"]',
  access: '[data-testid="admin-people"]',
  "api-access": '[data-testid="admin-api-access"]',
  settings: '[data-testid="admin-settings"]',
  workflows: '[data-testid="catalog-workflows"]',
  connectors: '[data-testid="catalog-connectors"]',
  knowledge: '[data-testid="catalog-knowledge"]',
  skills: '[data-testid="catalog-skills"]',
  files: '[data-testid="files-page"]',
  "workflows/$resourceId": '[data-testid="detail-workflows"]',
  "connectors/$resourceId": '[data-testid="detail-connectors"]',
  "knowledge/$resourceId": '[data-testid="detail-knowledge"]',
  "skills/$resourceId": '[data-testid="detail-skills"]',
  "files/$resourceId": '[data-testid="file-sheet"]',
};

const NOW = Date.now();

const API_KEY_SCOPES = [
  ["workflow:read", "workflow:run"],
  ["*", "rbac:write", "connector:write"],
];
const days = (count) => new Date(NOW - count * 86_400_000).toISOString();
const hours = (count) => new Date(NOW + count * 3_600_000).toISOString();

const ID = "018f4b4a-6d33-7b3a-9c2d-123456789abc";

const PATCH_CANDIDATES = [
  {
    id: ID,
    tenant_id: ID,
    workflow_id: ID,
    workflow_name: "Monatsreport",
    connector_id: ID,
    endpoint_key: "POST /reports",
    classification: "safe",
    status: "proposed",
    fixture_id: ID,
    created_at: days(19),
    updated_at: days(19),
    diff: {
      execution_id: ID,
      step_id: "fetch",
      drift_diff: "kind: schema_diff\nwidened: data.id",
      drift_signal: { kind: "schema_diff" },
      classification_reasons: ["field rename only"],
      proposal: {
        classification: "safe",
        kind: "update_field_path",
        description: "Field follows the rename: data.id -> data.result.id",
        patch: { path: "data.id", value: "data.result.id" },
        reasoning: "The response has carried the identifier under result since 8 August.",
      },
    },
  },
  {
    id: "patch-2",
    tenant_id: ID,
    workflow_id: ID,
    workflow_name: "Umsatzrollup",
    connector_id: null,
    endpoint_key: null,
    classification: "unsafe",
    status: "proposed",
    fixture_id: null,
    created_at: days(7),
    updated_at: days(7),
    diff: {
      execution_id: null,
      drift_diff: "kind: stdlib_version_drift\nrecorded_major: 1\ncurrent_major: 2",
      drift_signal: { kind: "stdlib_version_drift" },
      classification_reasons: ["major version change"],
      proposal: {
        classification: "unsafe",
        kind: "other",
        description: "Bump the built-in module to the current major",
      },
    },
  },
  {
    id: "patch-3",
    tenant_id: ID,
    workflow_id: ID,
    workflow_name: "Rechnungsversand",
    connector_id: ID,
    endpoint_key: "GET /invoices",
    classification: "safe",
    status: "proposed",
    fixture_id: ID,
    created_at: days(1),
    updated_at: days(1),
    diff: {
      execution_id: ID,
      drift_diff: "kind: path_miss\nmissing: data.total",
      drift_signal: { kind: "path_miss" },
      classification_reasons: ["field rename only"],
      proposal: {
        classification: "safe",
        kind: "update_field_path",
        description: "Field follows the rename: total -> total_amount",
        patch: { path: "data.total", value: "data.total_amount" },
      },
    },
  },
];

const SKILL_CANDIDATES = [
  {
    id: ID,
    tenant_id: ID,
    scope: "workflow",
    connector_id: null,
    workflow_id: ID,
    endpoint_key: null,
    pattern_kind: "repair_pattern",
    title: "Umbenannte Antwortfelder zuerst prüfen",
    body: "Wenn ein Schritt plötzlich nichts liest, hat das System meist ein Feld verschoben.",
    examples: ["data.id wurde zu data.result.id"],
    best_practices: ["Aufgezeichnete Antwort als Vergleich heranziehen"],
    pitfalls: ["Nicht den ganzen Schritt neu schreiben, nur den Pfad"],
    doc_refs: ["docs/concepts/workflows.md"],
    evidence_count: 2,
    confidence: "high",
    status: "proposed",
    promoted_skill_id: null,
    fingerprint: "fp-1",
    version: 1,
    tags: ["domain:reporting"],
    created_at: days(20),
    updated_at: days(20),
  },
];

const AWAITING_CONVERSATIONS = [
  {
    id: ID,
    tenant_id: ID,
    target_workflow_id: ID,
    target_connector_id: null,
    status: "awaiting_input",
    owner_id: ID,
    model: "test-model",
    title: "Monatsreport reparieren",
    created_at: days(2),
    updated_at: days(2),
    last_message_role: "assistant",
    last_message_excerpt: "Soll ich die gespeicherte Version ersetzen?",
    pending_elicitation_expires_at: hours(6),
    pending_elicitation_summary: "Soll ich die gespeicherte Version ersetzen?",
    pending_elicitation_tool: "ask_user_confirm",
  },
  {
    id: "conversation-2",
    tenant_id: ID,
    target_workflow_id: null,
    target_connector_id: null,
    status: "awaiting_input",
    owner_id: ID,
    model: "test-model",
    title: "Umsatzrollup umstellen",
    created_at: days(5),
    updated_at: days(5),
    last_message_role: "assistant",
    last_message_excerpt: "Welche Zielablage soll der Lauf beschreiben?",
    pending_elicitation_expires_at: hours(-4),
    pending_elicitation_summary: "Welche Zielablage soll der Lauf beschreiben?",
    pending_elicitation_tool: "ask_user_form",
  },
];

const RESUME_SUMMARY = {
  active_target: {
    kind: "connector",
    name: "Reporting API 1",
    slug: "reporting-api-0",
    id: ID,
    environment: "prod",
  },
  stage: "connector_drafting",
  last_successful_probe: null,
  last_successful_preview: null,
  unsaved: true,
  pending_approval: null,
  next_action: "Probe the connector draft before saving so auth and response shape are verified.",
  one_sentence: 'You were drafting connector "Reporting API 1" in prod but have not probed it yet.',
};

const CONVERSATION_TOTAL = AWAITING_CONVERSATIONS.length + 2;

const PATCH_ROWS = [...PATCH_CANDIDATES, PATCH_CANDIDATES[0]];

const NOTIFICATION_RULES = [
  {
    id: ID,
    tenant_id: ID,
    name: "Gescheiterte geplante Läufe",
    event_pattern: "execution.failed",
    workflow_pattern: "*",
    severity: "error",
    request_source_filter: ["scheduler"],
    target_workspace_id: "workspace-betrieb",
    target_channel_id: "kanal-betrieb",
    active: true,
    created_at: days(30),
    updated_at: days(30),
  },
];

const NOTIFICATION_CHANNELS = [
  {
    id: ID,
    tenant_id: ID,
    workspace_id: "workspace-betrieb",
    channel_id: "kanal-betrieb",
    platform: "Slack",
    default_severity: "warn",
    rate_limit_per_minute: 10,
    circuit_state: "closed",
    circuit_open_until: null,
    consecutive_failures: 0,
    active: true,
    created_at: days(30),
    updated_at: days(30),
  },
];

const FAILURE_GROUPS = [
  {
    signature: "monthly:fetch:http_502",
    workflow_id: ID,
    workflow_name: "Monatsreport",
    step_key: "fetch",
    error_code: "http_502",
    origin: "scheduled",
    count: 14,
    scheduled_count: 14,
    last_seen: days(0),
    cause: "Das angebundene System antwortet seit gestern mit einem Fehler.",
    guidance: "Zugangsdaten prüfen und den Lauf erneut anstoßen.",
    resolved_at: null,
  },
  {
    signature: "monthly:store:storage_refused",
    workflow_id: ID,
    workflow_name: "Monatsreport",
    step_key: "store",
    error_code: "storage_refused",
    origin: "scheduled",
    count: 3,
    scheduled_count: 3,
    last_seen: days(2),
    cause: "Die Ablage hat den Schreibzugriff abgelehnt.",
    guidance: null,
    resolved_at: days(1),
  },
];

function healthDigest(gateOpen) {
  return {
    generated_at: days(0),
    window_hours: 24,
    headline: gateOpen ? "Ein geplanter Lauf scheitert wiederholt." : "Nichts Auffälliges.",
    failure_groups: gateOpen ? FAILURE_GROUPS : [],
    patch_candidates: {
      pending: gateOpen ? PATCH_CANDIDATES.length : 0,
      items: gateOpen
        ? PATCH_CANDIDATES.map((candidate, index) => ({
            id: candidate.id,
            workflow_id: candidate.workflow_id,
            workflow_name: candidate.workflow_name,
            classification: candidate.classification,
            age_days: [19, 7, 1][index] ?? 0,
            stuck: index === 0,
            summary: candidate.diff.proposal.description,
          }))
        : [],
    },
    risk: [],
    rendered: gateOpen ? "Attention needed" : "All clear",
    all_clear: !gateOpen,
  };
}

const ENGINE_DETAIL = "HTTP 401 from upstream: token rejected";
const CONNECTOR_ID = "018f4b4a-6d33-7b3a-9c2d-00000000c0c0";

const ATTENTION_ITEMS = [
  {
    id: `conversation:${ID}`,
    class: "stopped",
    severity: "urgent",
    kind: "conversation",
    subject: { kind: "conversation", id: ID, name: "Quartalsabschluss" },
    reason: "awaiting_answer",
    cause_class: null,
    counts: {},
    since: days(1),
    deadline: null,
    detail: null,
    actions: [
      {
        verb: "answer",
        href: `/cockpit/chat/${ID}`,
        primary: true,
        permission: "conversation:write",
      },
    ],
  },
  {
    id: `workflow:${ID}`,
    class: "failing",
    severity: "urgent",
    kind: "workflow",
    subject: { kind: "workflow", id: ID, name: "Monatsreport" },
    reason: "failing",
    cause_class: "auth_failed",
    counts: { failures: 4, patches: 3 },
    since: days(19),
    deadline: null,
    detail: ENGINE_DETAIL,
    actions: [
      {
        verb: "review",
        href: `/cockpit?review=workflow:${ID}`,
        primary: true,
        permission: "workflow:write",
      },
      {
        verb: "open_runs",
        href: `/cockpit?runs=all&workflow_id=${ID}&status=failed`,
        primary: false,
        permission: "execution:read",
      },
    ],
  },
  {
    id: `connector:${CONNECTOR_ID}`,
    class: "failing",
    severity: "urgent",
    kind: "connector",
    subject: { kind: "connector", id: CONNECTOR_ID, name: "CRM" },
    reason: "needs_reauth",
    cause_class: null,
    counts: {},
    since: days(2),
    deadline: null,
    detail: "refresh token revoked",
    actions: [
      {
        verb: "reauth",
        href: `/cockpit/connectors/${CONNECTOR_ID}`,
        primary: true,
        permission: "connector:oauth",
      },
    ],
  },
  {
    id: "skills",
    class: "decide",
    severity: "urgent",
    kind: "skill_candidates",
    subject: null,
    reason: "skills_proposed",
    cause_class: null,
    counts: { skills: SKILL_CANDIDATES.length },
    since: days(20),
    deadline: null,
    detail: null,
    actions: [
      { verb: "review", href: "/cockpit?review=skills", primary: true, permission: "skill:write" },
    ],
  },
];

const ATTENTION_SOURCES = [
  "conversations",
  "schedules",
  "freshness",
  "failures",
  "patches",
  "connectors",
  "connections",
  "secret_approvals",
  "skills",
  "budget",
  "risk",
];

function attentionFixture(gateOpen, failedSource = null) {
  return {
    schema_version: "attention.v1",
    generated_at: days(0),
    sources: Object.fromEntries(
      ATTENTION_SOURCES.map((source) => [source, source === failedSource ? "failed" : "answered"]),
    ),
    status: {
      health_state: gateOpen ? "critical" : "healthy",
      next_run_at: new Date(NOW + 3_600_000).toISOString(),
    },
    items: gateOpen ? ATTENTION_ITEMS : [],
  };
}

const BOOTSTRAP = {
  principal: {
    id: ID,
    kind: "user",
    email: "betrieb@example.org",
    role_name: "admin",
    provider: "browser_session",
  },
  tenant: { id: ID, slug: "default", display_name: "Default Tenant" },
  session: { expires_at: hours(12), absolute_expires_at: null },
  permissions: [
    "conversation:read",
    "conversation:write",
    "conversation:approve",
    "workflow:read",
    "workflow:write",
    "execution:read",
    "connector:read",
    "connector:write",
    "connector:test",
    "knowledge:read",
    "knowledge:write",
    "skill:read",
    "skill:write",
    "file:read",
    "file:write",
    "notification:read",
    "audit:read",
    "stats:read",
    "stats:read:all",
    "identity:read",
    "rbac:read",
    "api_key:read",
    "settings:read",
    "identity:write",
    "rbac:write",
    "api_key:write",
    "settings:write",
    "self_healing:read",
    "self_healing:write",
    "connection:read",
    "connection:write",
    "mcp_oauth_client:read",
  ],
  csrf_token: "test-csrf",
  version: "konvention-check",
  recent_conversations: [],
};

function catalogRows(path) {
  return Array.from({ length: 8 }, (_, index) => {
    const rotate = index % 4;
    const base = {
      id: index === 0 ? ID : `${path}-row-${index}`,
      tenant_id: ID,
      updated_at: days(1),
    };
    if (path === "/v1/workflows")
      return {
        ...base,
        slug: `reporting-monatsreport-${index}`,
        name: `Monatsreport ${index + 1}`,
        category: index % 2 === 0 ? "reporting" : "betrieb",
        lifecycle: ["active", "draft", "archived", "active"][rotate],
        current_version: 8,
        connectors: rotate === 2 ? [] : ["reporting-api", "mailer"].slice(0, rotate + 1),
        trigger: rotate === 1 ? { kind: "schedule", cron: "0 6 * * *", tz: "UTC" } : null,
        effective_trigger:
          rotate === 1
            ? { kind: "schedule", source: "definition", state: "active" }
            : { kind: "request", source: "default", state: "active" },
        health_state: rotate === 3 ? "degraded" : "ok",
        health_reason: rotate === 3 ? "Drei Läufe in Folge fehlgeschlagen." : null,
        last_executed_at: days(1),
      };
    if (path === "/v1/connectors")
      return {
        ...base,
        slug: `reporting-api-${index}`,
        display_name: `Reporting API ${index + 1}`,
        category: index % 2 === 0 ? "reporting" : "betrieb",
        driver: ["http", "graphql", "postgres", "s3"][rotate],
        environment: index % 2 === 0 ? "prod" : "dev",
        auth_type: rotate === 2 ? "none" : "oauth2",
        health_state: ["ok", "needs_reauth", "ok", "degraded"][rotate],
        health_reason: rotate === 3 ? "Endpunkt antwortet mit 502." : null,
        needs_reauth: rotate === 1,
        auth_failed_at: rotate === 1 ? days(1) : null,
        enabled: rotate !== 2,
      };
    if (path === "/v1/knowledge-sources")
      return {
        ...base,
        name: `Betriebshandbuch ${index + 1}`,
        status: ["active", "processing", "error", "inactive"][rotate],
        scope: rotate === 1 ? "workflow" : "global",
        workflow_id: rotate === 1 ? ID : null,
        source_type: "file_upload",
        chunk_count: 12,
        bytes_total: 18_400,
      };
    if (path === "/v1/skills")
      return {
        ...base,
        title: `Sichere Reports ${index + 1}`,
        status: ["active", "draft", "archived", "active"][rotate],
        scope: ["global", "connector", "workflow", "global"][rotate],
        connector_id: rotate === 1 ? ID : null,
        workflow_id: rotate === 2 ? ID : null,
        side_effects: ["read", "write", "destructive", "none"][rotate],
        maturity: rotate === 1 ? "experimental" : "stable",
        version: 3,
      };
    return {
      ...base,
      filename: `report-notes-${index + 1}.md`,
      status: ["ready", "scanning", "ready", "expired"][rotate],
      scan_result: ["clean", "noop", "infected", "clean"][rotate],
      content_type: "text/markdown",
      size_bytes: 1840,
      created_at: days(1),
    };
  });
}

const EXECUTION_ROWS = Array.from({ length: 8 }, (_, index) => {
  const rotate = index % 4;
  const started = new Date(NOW - index * 300_000);
  return {
    id: index === 0 ? ID : `execution-${index}`,
    workflow_id: ID,
    workflow_name: `Monatsreport ${index + 1}`,
    workflow_version_id: null,
    source_kind: ["saved", "draft", "step", "saved"][rotate],
    source_ref: null,
    status: ["succeeded", "running", "failed", "timed_out"][rotate],
    request_source: ["scheduler", "chat", "api", "scheduler"][rotate],
    parent_execution_id: null,
    started_at: started.toISOString(),
    finished_at: rotate === 1 ? null : new Date(started.getTime() + 119_600).toISOString(),
    created_at: started.toISOString(),
  };
});

const DETAIL_EXTRAS = {
  "/v1/workflows": {
    description: "Fasst die Zahlen des Vormonats zusammen und verschickt den Bericht.",
    steps: [
      {
        key: "fetch",
        uses: "reporting-api",
        description: "Zahlen des Vormonats abrufen",
        kind: "connector",
      },
      {
        key: "send",
        uses: "mailer",
        description: "Bericht verschicken",
        kind: "connector",
      },
    ],
  },
  "/v1/skills": {
    body: "# Sichere Reports\n\nErst die aufgezeichnete Antwort vergleichen, dann den Pfad ändern.\n",
  },
};

const DETAIL_LISTS = [
  "/v1/workflows",
  "/v1/connectors",
  "/v1/knowledge-sources",
  "/v1/skills",
  "/v1/files",
];

function detailRecord(listPath) {
  return { ...catalogRows(listPath)[0], ...(DETAIL_EXTRAS[listPath] ?? {}) };
}

const WORKFLOW_INVOCATION = (() => {
  const address = "https://engine.example.test";
  const sample = { month: "<month>" };
  const body = { source: "saved", workflow_id: ID, input: sample };
  const call = (environment, language) =>
    `# ${language}\ncurl -sS -X POST '${address}/v1/executions' -H 'x-subkit-environment: ${environment}' -d '${JSON.stringify(body)}'`;
  return {
    workflow_id: ID,
    slug: "reporting-monatsreport",
    base_url: address,
    http: {
      method: "POST",
      path: "/v1/executions",
      url: `${address}/v1/executions`,
      headers: ["authorization", "x-subkit-environment", "content-type"],
      body,
      snippets: Object.fromEntries(
        ["dev", "prod"].map((environment) => [
          environment,
          Object.fromEntries(
            ["curl", "node", "python"].map((language) => [language, call(environment, language)]),
          ),
        ]),
      ),
    },
    hooks: [],
    mcp: {
      tool_name: "wf_reporting-monatsreport",
      fallback: {
        tool_name: "run_workflow",
        arguments: { workflow: "reporting-monatsreport", input: sample },
      },
    },
    schedules: [],
    cli: {
      command: `sk workflows run reporting-monatsreport --input '${JSON.stringify(sample)}'`,
      environment: "dev",
    },
    input: {
      source: "declared",
      schema: {
        type: "object",
        required: ["month"],
        properties: {
          month: { type: "string", description: "Abrechnungsmonat", example: "2026-07" },
          dry: { type: "boolean" },
        },
      },
      sample,
    },
    output: { schema: { type: "object", properties: { rows: { type: "integer" } } } },
    invalid: false,
    visibility: { hooks: true, schedules: true },
    webhook_input_shape: {
      id: "string",
      type: "string",
      timestamp: "number",
      headers: "object",
      body: "json",
    },
    authority: { dev: "held_preview_only", prod: "held_preview_only" },
  };
})();

const KNOWLEDGE_CONTENT = {
  knowledge_source_id: ID,
  version: "3",
  editable: true,
  documents: [
    {
      path: "betriebshandbuch.md",
      content: "# Betriebshandbuch\n\nWer den Monatsreport betreut, prüft zuerst die Zugänge.\n",
    },
  ],
};

const FILE_CONTENT = "# Notizen zum Report\n\nDie Zahlen stammen aus dem Vormonat.\n";

const EXECUTION_STEPS = [
  {
    id: "step-1",
    execution_id: ID,
    step_key: "fetch",
    status: "succeeded",
    started_at: days(0),
    finished_at: days(0),
    duration_ms: 840,
    attempt: 1,
    error: null,
    output_preview: null,
    result_preview: null,
  },
  {
    id: "step-2",
    execution_id: ID,
    step_key: "send",
    status: "succeeded",
    started_at: days(0),
    finished_at: days(0),
    duration_ms: 260,
    attempt: 1,
    error: null,
    output_preview: "2 Empfänger benachrichtigt.",
    result_preview: null,
  },
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function apiMock(gateOpen, { unknownDecisionKind = false, failedAttentionSource = null } = {}) {
  return async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const status = url.searchParams.get("status");

    if (path === "/v1/cockpit/bootstrap") return json(route, BOOTSTRAP);
    if (path === "/v1/operator/health-digest") return json(route, healthDigest(gateOpen));
    if (path === "/v1/schedules") return json(route, { schedules: [], total: 0 });
    if (path === "/v1/attention")
      return json(route, attentionFixture(gateOpen, failedAttentionSource));

    if (path === "/v1/patch-candidates") {
      const scope = url.searchParams.get("workflow_id");
      const items = (gateOpen && status === "proposed" ? PATCH_ROWS : []).filter(
        (candidate) => !scope || candidate.workflow_id === scope,
      );
      const presented = unknownDecisionKind
        ? items.map((candidate, index) =>
            index === 0
              ? {
                  ...candidate,
                  diff: {
                    ...candidate.diff,
                    proposal: {
                      ...candidate.diff.proposal,
                      kind: "future_operator_choice",
                    },
                  },
                }
              : candidate,
          )
        : items;
      return json(route, {
        items: presented.map((candidate) => ({
          ...candidate,
          reviewable: candidate.id !== "patch-2",
          review_reason: candidate.id === "patch-2" ? "no_step_anchor" : null,
          review_digest: candidate.id === "patch-2" ? null : "a".repeat(64),
          base_version_id: ID,
        })),
        reviewable_total: gateOpen ? PATCH_CANDIDATES.length - 1 : 0,
        total: gateOpen ? PATCH_CANDIDATES.length : 0,
      });
    }
    if (path === "/v1/skill-candidates") {
      const items = gateOpen && status === "proposed" ? SKILL_CANDIDATES : [];
      return json(route, {
        items: items.map((candidate) => ({
          ...candidate,
          reviewable: true,
          review_digest: "b".repeat(64),
        })),
        total: items.length,
        reviewable_total: items.length,
      });
    }
    if (path === `/v1/skill-candidates/${ID}/evidence`) return json(route, { items: [] });

    if (path === "/v1/conversations") {
      if (status === "awaiting_input" && !gateOpen) return json(route, { items: [], total: 0 });
      const items = AWAITING_CONVERSATIONS;
      return json(route, {
        items,
        total: status === "awaiting_input" ? CONVERSATION_TOTAL : items.length,
      });
    }
    if (path === `/v1/conversations/${ID}`)
      return json(route, {
        conversation: AWAITING_CONVERSATIONS[0],
        messages: [
          {
            id: "message-1",
            role: "user",
            created_at: days(2),
            parts: [{ type: "text", text: "Bitte repariere den Monatsreport." }],
          },
          {
            id: "message-2",
            role: "assistant",
            created_at: days(2),
            parts: [
              {
                type: "text",
                text: "Ich habe die fehlerhafte Umwandlung eingegrenzt.",
              },
            ],
          },
        ],
        tool_calls: [],
        resume_summary: RESUME_SUMMARY,
        draft: { session: { permission_mode: "ask" } },
        usage: { tokens: 0, by_model: [], cost: null },
      });

    for (const listPath of DETAIL_LISTS) {
      if (path === `${listPath}/${ID}`) return json(route, detailRecord(listPath));
    }
    if (path === `/v1/workflows/${ID}/invocation`) return json(route, WORKFLOW_INVOCATION);
    if (path === `/v1/workflows/${ID}/automation-status`)
      return json(route, { schedules: [], inbound_hooks: [] });
    if (path === `/v1/workflows/${ID}/diagnosis`)
      return json(route, {
        workflow_id: ID,
        workflow_version_id: null,
        environment: url.searchParams.get("environment") ?? "prod",
        is_current: true,
        diagnoses: [],
      });
    if (path === `/v1/workflows/${ID}/execution-authorities`)
      return json(route, { items: [], next_cursor: null });
    if (path === `/v1/knowledge-sources/${ID}/content`) return json(route, KNOWLEDGE_CONTENT);
    if (path === `/v1/files/${ID}/usage`)
      return json(route, {
        workflows: [{ id: ID, name: "Monatsreport" }],
        conversations: [{ id: ID, title: null }],
        other: 1,
      });
    if (path === `/v1/files/${ID}/content`)
      return route.fulfill({
        status: 200,
        contentType: "text/markdown",
        body: FILE_CONTENT,
      });

    if (DETAIL_LISTS.includes(path)) {
      const items = catalogRows(path)
        .filter(
          (row) =>
            path !== "/v1/connectors" ||
            url.searchParams.get("health") !== "not_ok" ||
            (row.enabled === true && row.health_state !== "ok"),
        )
        .filter(
          (row) =>
            path !== "/v1/connectors" ||
            url.searchParams.get("enabled") !== "true" ||
            row.enabled === true,
        );
      const categories =
        path === "/v1/workflows" || path === "/v1/connectors"
          ? [
              { category: "reporting", count: 4 },
              { category: "betrieb", count: 4 },
            ]
          : undefined;
      return json(route, {
        items,
        total: items.length,
        ...(categories ? { categories } : {}),
      });
    }

    if (path === "/v1/executions")
      return json(route, {
        items: EXECUTION_ROWS,
        total: EXECUTION_ROWS.length,
        next_cursor: null,
      });
    if (path === `/v1/executions/${ID}`) return json(route, EXECUTION_ROWS[0]);
    if (path === `/v1/executions/${ID}/steps`) return json(route, { items: EXECUTION_STEPS });

    if (path === "/v1/audit-log") {
      const wanted = (url.searchParams.get("action") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      const rows = [
        {
          action: "patch_candidate.approved",
          resource_type: "patch_candidate",
          result: "success",
          actor_type: "user",
          reason: null,
        },
        {
          action: "skill_candidate.rejected",
          resource_type: "skill_candidate",
          result: "success",
          actor_type: "user",
          reason: "Deckt sich mit einem schon freigegebenen Skill.",
        },
        {
          action: "workflow.updated",
          resource_type: "workflow",
          result: "success",
          actor_type: "system_account",
          reason: null,
        },
        {
          action: "connector.invoked",
          resource_type: "connector",
          result: "denied",
          actor_type: "system",
          reason: "Rolle deckt skill:write nicht ab.",
        },
        {
          action: "settings.write",
          resource_type: "settings",
          result: "error",
          actor_type: "user",
          reason: null,
        },
      ];
      const selected = wanted.length > 0 ? rows.filter((row) => wanted.includes(row.action)) : rows;
      return json(route, {
        items: selected.map((row, index) => ({
          id: index === 0 ? ID : `audit-${index}`,
          ts: new Date(NOW - index * 120_000).toISOString(),
          tenant_id: ID,
          actor_id: row.actor_type === "system" ? null : ID,
          resource_id: row.resource_type === "settings" ? null : ID,
          trace_id: null,
          ip: null,
          user_agent: null,
          before: null,
          after: null,
          metadata: {},
          ...row,
        })),
        next_cursor: null,
      });
    }

    if (path === "/v1/notifications/rules") return json(route, { items: NOTIFICATION_RULES });
    if (path === "/v1/notifications/channels") return json(route, { items: NOTIFICATION_CHANNELS });

    if (path === "/v1/notifications/inbox")
      return json(route, {
        items: Array.from({ length: 6 }, (_, index) => ({
          id: index + 1,
          severity: ["error", "warn", "info", "critical"][index % 4],
          event_type: ["execution.failed", "connector.auth_failed", "patch.proposed"][index % 3],
          event_payload: {},
          actionable: index % 2 === 0,
          resource_type: ["execution", "connector", "patch_candidate"][index % 3],
          resource_id: ID,
          read: index % 3 === 0,
          read_at: index % 3 === 0 ? days(1) : null,
          created_at: new Date(NOW - index * 600_000).toISOString(),
        })),
        cursor: null,
        unread_count: 4,
        actionable_unread_count: 3,
      });

    if (path === "/v1/stats/llm") {
      if (!url.searchParams.get("bucket") || !url.searchParams.get("from"))
        return json(route, { code: "validation", message: "request validation failed" }, 400);
      const tokens = { prompt: 0, completion: 0, cache_read: 0, cache_creation: 0, total: 0 };
      const latency = { total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
      return json(route, {
        bucket: url.searchParams.get("bucket"),
        tz: "UTC",
        from: url.searchParams.get("from"),
        to: new Date().toISOString(),
        groups: [],
        totals: { calls: { total: 320, by_result: {} }, tokens, latency_ms: latency },
        cost: {
          amount: 87.22,
          currency: "USD",
          unpriced_models: ["some-new-model"],
          unpriced_calls: 12,
          price_sources: [{ model: "claude-sonnet-4-6", price_source: "catalog" }],
          rates_basis: "current",
        },
      });
    }

    if (path === "/v1/status")
      return json(route, {
        tokens_today: 1_240_000,
        tokens_month: 40_500_000,
        monthly_budget_tokens: 150_000_000,
        remaining_monthly_budget_tokens: 109_500_000,
        monthly_budget_state: "ample",
      });

    if (path === "/v1/stats/operating-figures") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (!from || !to)
        return json(route, { code: "validation", message: "request validation failed" }, 400);
      const rows = catalogRows("/v1/connectors").filter((row) => row.enabled === true);
      const notOk = rows.filter((row) => row.health_state !== "ok").length;
      const window = { started_from: from, started_to: to };
      return json(route, {
        schema_version: "operating-figures.v1",
        window: { from, to },
        runs: {
          total: 22,
          succeeded: 20,
          failed: 2,
          finished: 22,
          success_rate_percent: 91,
          href: `/cockpit?${new URLSearchParams({ runs: "all", ...window })}`,
          failed_href: `/cockpit?${new URLSearchParams({ runs: "all", status: "failed", ...window })}`,
        },
        connectors: {
          enabled: rows.length,
          not_ok: notOk,
          healthy_percent: Math.round(((rows.length - notOk) / rows.length) * 100),
          href: "/cockpit/connectors?health=not_ok",
        },
        repairs: {
          decided: 3,
          applied: 2,
          applied_percent: 67,
          href: `/cockpit/audit?${new URLSearchParams({ scope: "all", ts_from: from, ts_to: to })}`,
        },
      });
    }

    if (path === "/v1/stats/events") {
      if (!url.searchParams.get("bucket") || !url.searchParams.get("from"))
        return json(route, { code: "validation", message: "request validation failed" }, 400);
      const group = (action, total) => ({
        key: { action },
        buckets: [],
        totals: {
          calls: { total, by_outcome: { success: total, denied: 0, error: 0 } },
          latency_ms: { total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
        },
      });
      return json(route, {
        bucket: url.searchParams.get("bucket"),
        tz: "UTC",
        from: url.searchParams.get("from"),
        to: new Date().toISOString(),
        groups:
          url.searchParams.get("class") === "self_healing"
            ? [
                group("patch_candidate.proposed", 5),
                group("patch_candidate.approved", 1),
                group("patch_candidate.auto_applied", 1),
                group("patch_candidate.rejected", 1),
              ]
            : [],
        totals: {
          calls: { total: 0, by_outcome: { success: 0, denied: 0, error: 0 }, by_status_class: {} },
          latency_ms: { total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
        },
      });
    }

    if (path === "/v1/stats/executions") {
      if (!url.searchParams.get("bucket") || !url.searchParams.get("from"))
        return json(route, { code: "validation", message: "request validation failed" }, 400);
      const duration = {
        total: 44_400,
        avg: 1110,
        p50: 850,
        p95: 2300,
        p99: 2700,
        max: 3200,
      };
      return json(route, {
        bucket: "day",
        tz: "UTC",
        from: days(30),
        to: days(0),
        groups: [
          {
            key: {},
            buckets: [{ ts: days(1), executions: 22, duration_ms: duration }],
            totals: { executions: 22, duration_ms: duration },
          },
        ],
        totals: {
          executions: { count: 22, by_status: { completed: 20, failed: 2 } },
          duration_ms: duration,
        },
      });
    }

    if (path === "/v1/connections")
      return json(route, {
        items: [
          {
            id: ID,
            name: "wiki",
            base_url: "https://wiki.example.org",
            issuer: "https://wiki.example.org",
            service_name: "Wissensbasis",
            service_description: "Die interne Wissensbasis der Firma.",
            scopes: ["read", "write"],
            granted_scopes: ["read", "write"],
            state: "valid",
            auto_renew: true,
            expires_at: hours(1),
            last_used_at: days(0.1),
            last_refreshed_at: days(0.5),
            refresh_failed_at: null,
            last_error: null,
            state_reason: null,
            used_by: [
              {
                connector_id: ID,
                slug: "reporting-api-0",
                display_name: "Reporting API 1",
                workflow_count: 3,
              },
            ],
            created_at: days(20),
          },
          {
            id: "018f4b4a-6d33-7b3a-9c2d-123456789abd",
            name: "kalender",
            base_url: "https://kalender.example.org",
            issuer: "https://kalender.example.org",
            service_name: null,
            service_description: null,
            scopes: ["read"],
            granted_scopes: ["read"],
            state: "expired",
            auto_renew: true,
            expires_at: days(1),
            last_used_at: days(3),
            last_refreshed_at: days(2),
            refresh_failed_at: days(1),
            last_error: "token endpoint refused: invalid_grant",
            state_reason: "refresh_refused",
            used_by: [],
            created_at: days(40),
          },
          {
            id: "018f4b4a-6d33-7b3a-9c2d-123456789abe",
            name: "archiv",
            base_url: "https://archiv.example.org",
            issuer: "https://archiv.example.org",
            service_name: "Archiv",
            service_description: null,
            scopes: ["read"],
            granted_scopes: null,
            state: "expiring",
            auto_renew: false,
            expires_at: hours(72),
            last_used_at: null,
            last_refreshed_at: null,
            refresh_failed_at: null,
            last_error: null,
            state_reason: null,
            used_by: [],
            created_at: days(2),
          },
          {
            id: "018f4b4a-6d33-7b3a-9c2d-123456789abf",
            name: "ablage",
            base_url: "https://ablage.example.org",
            issuer: "https://ablage.example.org",
            service_name: "Ablage",
            service_description: null,
            scopes: ["files.read"],
            granted_scopes: ["files.read"],
            state: "expired",
            auto_renew: false,
            expires_at: days(3),
            last_used_at: days(4),
            last_refreshed_at: null,
            refresh_failed_at: null,
            last_error: null,
            state_reason: "expired_no_refresh",
            used_by: [],
            created_at: days(60),
          },
        ],
      });
    if (path === `/v1/connectors/${ID}/credential`)
      return json(route, {
        mode: "connection",
        environment: "prod",
        connection: { id: ID, name: "wiki", state: "expired" },
        header_names: [],
        updated_at: days(2),
      });
    if (path === `/v1/connectors/${ID}/runtime`)
      return json(route, {
        last_success_at: days(1),
        last_failure: { at: days(2), code: "4xx_auth", cause_class: "auth_failed" },
        recorded: true,
        mcp_session: null,
      });
    if (path === "/v1/stats/connectors")
      return json(route, {
        bucket: "day",
        tz: "UTC",
        from: url.searchParams.get("from") ?? days(7),
        to: url.searchParams.get("to") ?? days(0),
        groups: [],
        totals: {
          calls: {
            total: 42,
            by_outcome: { success: 39, denied: 1, error: 2 },
            by_status_class: { "2xx": 39, "4xx_auth": 2, no_status: 1 },
          },
          latency_ms: { total: 5_040, avg: 120, p50: 110, p95: 300, p99: 420, max: 500 },
        },
      });
    if (path === `/v1/connectors/${ID}/mcp/inspect`)
      return json(route, {
        connector_id: ID,
        slug: "reporting-api-0",
        tools: [
          { name: "search_items", description: "Einträge suchen", claims: "read" },
          { name: "create_item", description: "Eintrag anlegen", claims: "write" },
        ],
        capabilities: { tools: true, resources: false, prompts: false },
        instructions: null,
        server_version: null,
      });
    if (path === `/v1/connectors/${ID}/mcp/tool-confirmation`) {
      const body = JSON.parse(request.postData() ?? "{}");
      return json(route, {
        tool: body.tool,
        confirm: body.confirm,
        tools_without_confirmation: body.confirm ? [] : [body.tool],
      });
    }
    if (path === "/v1/secret-approvals")
      return json(route, {
        items: [
          {
            name: "settings.llm.providers.anthropic.api_key",
            version: 4,
            reference: "secret://settings.llm.providers.anthropic.api_key/4",
            prepared_by: "Host-Kommando (engine --vault-set --pending)",
            pending_since: days(1),
            bindings: ["llm.providers.anthropic.api_key"],
          },
        ],
      });
    if (path === "/v1/settings")
      return json(route, {
        saved_revision: 7,
        active_revision: 7,
        activation_status: "active",
        pending_restart_fields: [],
        items: [
          {
            path: "auth.providers",
            value: [
              { protocol: "api_key", id: "api-key", label: "Local API key" },
              {
                protocol: "oidc",
                id: "example-sso",
                label: "Example SSO",
                issuer_url: "https://auth.example.com",
                client_id: "oidc_subkit_public_client",
                scopes: "openid profile email",
                tenant_slug: "default",
              },
            ],
            meta: {
              source: "global",
              scope: "global",
              sensitive: false,
              requiresRestart: true,
              kind: "json",
            },
          },
          {
            path: "server.public_base_url",
            value: "https://subkit.example.com",
            meta: {
              source: "global",
              scope: "global",
              sensitive: false,
              requiresRestart: false,
              kind: "string",
            },
          },
          {
            path: "llm.default_model",
            value: "test-model",
            meta: {
              source: "tenant",
              scope: "tenant",
              sensitive: false,
              requiresRestart: false,
              description: "Modell, das ohne ausdrückliche Wahl verwendet wird.",
              kind: "string",
            },
          },
          {
            path: "queue.concurrency",
            value: 4,
            meta: {
              source: "default",
              scope: "global",
              sensitive: false,
              requiresRestart: true,
              kind: "number",
            },
          },
        ],
        diagnostics: { pending_restart_keys: [], override_keys: [] },
      });

    if (path === "/v1/identity/users")
      return json(route, {
        items: [
          {
            id: ID,
            email: "betrieb@example.org",
            role: "admin",
            status: "active",
            oauth_connections: 2,
          },
          {
            id: "user-2",
            email: "redaktion@example.org",
            role: "member",
            status: "active",
            oauth_connections: 0,
          },
        ],
      });

    if (path === "/v1/oauth/clients")
      return json(route, {
        items: [
          {
            id: ID,
            client_id: "reporting-desktop",
            client_name: "Reporting-Desktop",
            approved_by: ["betrieb@example.org"],
            live_connections: 1,
            disabled_at: null,
            created_at: days(12),
          },
        ],
      });

    if (path === "/v1/identity/api-keys")
      return json(route, {
        items: [
          {
            id: ID,
            name: "Reporting-Abruf",
            prefix: "sk_live_demo",
            scopes: API_KEY_SCOPES[0],
            created_at: days(30),
            last_used_at: days(1),
            expires_at: null,
            rotating_out_at: null,
            revoked_at: null,
          },
          {
            id: "018f4b4a-6d33-7b3a-9c2d-123456789ac0",
            name: "Altes Skript",
            prefix: "sk_live_old1",
            scopes: API_KEY_SCOPES[1],
            created_at: days(200),
            last_used_at: days(120),
            expires_at: days(5),
            rotating_out_at: null,
            revoked_at: null,
          },
          {
            id: "018f4b4a-6d33-7b3a-9c2d-123456789ac1",
            name: "Nachtlauf",
            prefix: "sk_live_nl01",
            scopes: API_KEY_SCOPES[0],
            created_at: days(20),
            last_used_at: days(1),
            expires_at: new Date(
              new Date(NOW).getFullYear(),
              new Date(NOW).getMonth(),
              new Date(NOW).getDate() + 3,
              12,
            ).toISOString(),
            rotating_out_at: null,
            revoked_at: null,
          },
        ],
      });

    if (path === "/v1/rbac/roles")
      return json(route, {
        items: [
          {
            id: ID,
            name: "admin",
            description: "Workspace administration",
            is_builtin: true,
          },
          {
            id: "role-2",
            name: "metrics_scraper",
            description: "Prometheus scraper",
            is_builtin: true,
          },
        ],
      });
    if (path === "/v1/rbac/groups")
      return json(route, {
        items: [{ id: ID, name: "Betrieb", description: "Operators" }],
      });
    if (path === "/v1/rbac/grants")
      return json(route, {
        items: [
          {
            id: ID,
            subject_type: "group",
            resource_type: "workflow",
            permission: "workflow:run",
            expires_at: null,
          },
        ],
      });
    if (path === "/v1/rbac/permissions")
      return json(route, {
        items: [
          {
            name: "workflow:run",
            description: "Run workflows",
            resource_type: "workflow",
          },
        ],
      });

    return json(route, { items: [], total: 0 });
  };
}

const violations = [];

function breach(rule, where, actual) {
  violations.push({ rule, where, actual });
}

const gaps = [];

function gap(where, why) {
  gaps.push({ where, why });
}

gap(
  "wordmark in the collapsed rail",
  "only the expanded sidebar is measured — breaking the icon or the name while collapsed passes here",
);
gap(
  "catalogue en",
  "every rule runs against de. The silent class: §2 forbids a STATE, what is measured is the WORD „Unbekannt“ — on en the same state reads „Unknown“ and goes unnoticed. English decision-state vocabulary therefore remains outside this sweep",
);
gap(
  "/ · §8.5 completeness of the history",
  "the ONE link and the naming of the four decision verbs in the log are measured; whether the log HOLDS every decision is not — that is the engine's write path, and this check never writes one",
);
gap(
  "/ · which entries Übersicht holds",
  "the list is measured against the attention fixture — one entry per subject, one primary action, badge = entries; whether the ENGINE puts the right facts into the list is the engine's own tests (operator/attention*.test.ts), not this check",
);

const swept = [];

function checkKonventionVersion() {
  const where = "COCKPIT-KONVENTION.md → Kopfzeile";
  let header;
  try {
    header = readFileSync(new URL("../COCKPIT-KONVENTION.md", import.meta.url), "utf8").slice(
      0,
      400,
    );
  } catch (error) {
    breach("§7", where, `no readable convention copy in the repo root (${String(error)})`);
    return;
  }
  konventionVersionImRepo = header.match(/^Version (\d+\.\d+(?:\.\d+)?)/m)?.[1] ?? null;
  if (konventionVersionImRepo !== KONVENTION_VERSION)
    breach(
      "§7",
      where,
      `version ${konventionVersionImRepo ?? "(no version in the header line)"} — this check is written by hand against v${KONVENTION_VERSION}`,
    );
}

async function checkRoleLabel(page) {
  const label = await page.locator('[data-testid="account-role"]').innerText();
  if (label.trim() !== "Administrator")
    breach("§5, §6", "/overview · [data-testid=account-role]", label.trim());
}

const PRODUCT_NAME = "SubKit";
const BROWSER_TITLE = `${PRODUCT_NAME} Cockpit`;

const COCKPIT_BASE = readFileSync(
  new URL("../apps/cockpit/vite.config.ts", import.meta.url),
  "utf8",
).match(/\bbase:\s*"([^"]+)"/)?.[1];
if (!COCKPIT_BASE) throw new Error("apps/cockpit/vite.config.ts nennt keinen base-Pfad");

async function checkWordmark(page) {
  const where = "/overview · Seitenleiste [data-testid=cockpit-wordmark]";
  const wordmark = page.locator('[data-testid="cockpit-wordmark"]');
  if ((await wordmark.count()) === 0) {
    breach("§6 (Wortmarke)", where, 'no wordmark with data-testid="cockpit-wordmark" in the DOM');
    return;
  }

  const seen = await wordmark.first().evaluate((node) => {
    const nameEl = node.querySelector('[data-testid="cockpit-wordmark-name"]');
    const iconHost = node.querySelector('[data-testid="cockpit-wordmark-icon"]');
    const iconEl = iconHost ? iconHost.querySelector("svg, img") : null;
    const nameStyle = nameEl ? getComputedStyle(nameEl) : null;
    const iconStyle = iconEl ? getComputedStyle(iconEl) : null;
    const box = iconEl ? iconEl.getBoundingClientRect() : null;
    return {
      containerText: node.textContent ?? "",
      hasName: Boolean(nameEl),
      nameText: nameEl?.textContent ?? "",
      transform: nameStyle?.textTransform ?? null,
      caps: nameStyle?.fontVariantCaps ?? null,
      hasIcon: Boolean(iconEl),
      iconVisible: Boolean(
        box &&
          box.width > 0 &&
          box.height > 0 &&
          iconStyle &&
          iconStyle.visibility !== "hidden" &&
          iconStyle.display !== "none" &&
          Number(iconStyle.opacity) > 0,
      ),
      iconBeforeName: Boolean(
        iconEl &&
          nameEl &&
          (iconEl.compareDocumentPosition(nameEl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      ),
    };
  });

  if (!seen.containerText.includes(PRODUCT_NAME))
    breach(
      "§6 (Wortmarke)",
      where,
      `"${seen.containerText.trim().split("\n")[0] ?? ""}" — does not contain "${PRODUCT_NAME}" character for character`,
    );

  if (!seen.hasName) {
    breach("§6 (Wortmarke)", where, 'no name line with data-testid="cockpit-wordmark-name"');
  } else {
    if (seen.transform === "uppercase" || seen.transform === "lowercase")
      breach(
        "§6 (Schreibweise)",
        `${where} · cockpit-wordmark-name`,
        `berechnetes text-transform: ${seen.transform}`,
      );
    if (seen.caps && seen.caps !== "normal")
      breach(
        "§6 (Schreibweise)",
        `${where} · cockpit-wordmark-name`,
        `berechnetes font-variant-caps: ${seen.caps}`,
      );
    const rendered = seen.nameText.trim();
    const hasLetters = rendered !== rendered.toUpperCase() || rendered !== rendered.toLowerCase();
    if (hasLetters && rendered === rendered.toUpperCase())
      breach("§6 (Schreibweise)", `${where} · cockpit-wordmark-name`, `Versalien: "${rendered}"`);
    if (hasLetters && rendered === rendered.toLowerCase())
      breach(
        "§6 (Schreibweise)",
        `${where} · cockpit-wordmark-name`,
        `kleingeschrieben: "${rendered}"`,
      );
  }

  if (!seen.hasIcon) {
    breach("§6 (App-Icon)", where, "no icon element beside the name");
  } else if (!seen.iconVisible) {
    breach("§6 (App-Icon)", where, "the icon element is in the DOM but not visible");
  } else if (seen.hasName && !seen.iconBeforeName) {
    breach("§6 (App-Icon)", where, "the icon does not precede the name");
  }
}

async function checkBrowserTitle(page) {
  const title = await page.title();
  if (title !== BROWSER_TITLE)
    breach("§6 (Browser-Titel)", "/overview · <title>", `"${title}" instead of "${BROWSER_TITLE}"`);
}

async function checkFavicon(page) {
  const where = "/overview · <link rel=icon>";
  const href = await page.evaluate(() => {
    const link = document.querySelector('link[rel~="icon"]');
    return link ? link.getAttribute("href") : null;
  });
  if (!href) {
    breach("§6 (App-Icon)", where, 'no <link rel="icon"> in the document');
    return;
  }

  const resolved = new URL(href, page.url()).toString();
  const at = `${where} → ${resolved}`;

  if (!new URL(resolved).pathname.startsWith(COCKPIT_BASE))
    breach(
      "§6 (App-Icon)",
      at,
      `the reference resolves outside the base path "${COCKPIT_BASE}" — the engine serves nothing there`,
    );

  const response = await page.request.get(resolved);
  if (response.status() !== 200) {
    breach("§6 (App-Icon)", at, `HTTP ${response.status()}`);
    return;
  }

  const type = response.headers()["content-type"] ?? "";
  if (!/^image\//i.test(type)) {
    breach(
      "§6 (App-Icon)",
      at,
      `status 200 but content type "${type}" — the reference lands on the SPA fallback, not on the icon`,
    );
    return;
  }

  const decoded = await page.evaluate(
    (url) =>
      new Promise((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve(probe.naturalWidth > 0 && probe.naturalHeight > 0);
        probe.onerror = () => resolve(false);
        probe.src = url;
      }),
    resolved,
  );
  if (!decoded)
    breach(
      "§6 (App-Icon)",
      at,
      "status 200 and an image content type, but the browser does not decode the file — the tab stays empty",
    );
}

async function checkAdminGroupName(page) {
  const group = page.locator('[data-testid="nav-group-admin"]');
  if ((await group.count()) === 0) {
    breach("§6", "/overview · Sidebar", "no admin nav group present");
    return;
  }
  const label = (await group.first().innerText()).split("\n")[0]?.trim() ?? "";
  if (label !== "Verwaltung") breach("§6", "/overview · nav-group-admin", label);
}

const INSTALLATION_ENTRIES = [
  "Nutzung",
  "Audit",
  "Personen & Rechte",
  "API-Zugang",
  "Einstellungen",
];

async function checkInstallationEntries(page) {
  const labels = await page.evaluate(() => {
    const group = document.querySelector('[data-testid="nav-group-admin"]');
    if (!group) return null;
    return [...group.querySelectorAll("a[data-testid]")].map((link) => link.innerText.trim());
  });
  if (labels === null) return;
  if (labels.join("|") !== INSTALLATION_ENTRIES.join("|"))
    breach(
      "§6",
      "/ · nav-group-admin",
      `entries are ${labels.join(", ")} instead of ${INSTALLATION_ENTRIES.join(", ")}`,
    );
  if (labels.includes("System"))
    breach("§6", "/ · nav-group-admin", 'the "System" entry is back — a third home for health');
  if (labels.includes("Zugriff"))
    breach("§6", "/ · nav-group-admin", 'a "Zugriff" entry beside Personen & Rechte — one page');
}

async function checkOverviewNavEntry(page) {
  const entry = page.locator('[data-testid="nav-overview"]');
  if ((await entry.count()) === 0) {
    breach("§6", "/ · Sidebar", 'no nav entry "Übersicht"');
    return null;
  }
  const label = (await entry.first().innerText()).trim().split("\n")[0]?.trim();
  if (label !== "Übersicht")
    breach("§6", "/ · nav-overview", `reads "${label}" instead of "Übersicht"`);
  const placement = await page.evaluate(() => {
    const today = document.querySelector('[data-testid="nav-overview"]');
    if (!today) return null;
    const group = today.closest('[data-testid^="nav-group-"]');
    const heading = group?.querySelector(
      '[data-slot="sidebar-group-label"], [data-sidebar="group-label"]',
    );
    const links = [...document.querySelectorAll('[data-testid^="nav-"]')].filter(
      (element) => element.tagName === "A",
    );
    return {
      groupHeading: heading instanceof HTMLElement ? heading.innerText.trim() : "",
      first: links[0]?.getAttribute("data-testid") ?? null,
      gone: ["nav-decisions", "nav-operations", "nav-runs", "nav-notifications"].filter((id) =>
        document.querySelector(`[data-testid="${id}"]`),
      ),
    };
  });
  if (placement?.groupHeading)
    breach("§6", "/ · nav-overview", `sits under the heading "${placement.groupHeading}"`);
  if (placement && placement.first !== "nav-overview")
    breach("§6", "/ · Sidebar", `the first entry is ${placement.first}, not Übersicht`);
  for (const id of placement?.gone ?? [])
    breach(
      "§6, §12",
      "/ · Sidebar",
      `${id} is still an entry — a second home for Übersicht's facts`,
    );

  const badge = page.locator('[data-testid="nav-overview-count"]');
  try {
    await badge.first().waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    breach("§8.1", "/ · nav-overview", "no counter badge on Übersicht although entries are open");
    return null;
  }
  return {
    count: (await badge.first().innerText()).trim(),
    stopped: await badge.first().getAttribute("data-attention-stopped"),
  };
}

async function checkNoUnknownState(page, where) {
  const hits = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((element) => {
        if (element.children.length > 0) return false;
        return /(^|\s)Unbekannt(\s|$|[.,;:!?])/.test(element.textContent ?? "");
      })
      .map(
        (element) =>
          `${element.tagName.toLowerCase()}: ${element.textContent?.trim().slice(0, 80)}`,
      ),
  );
  for (const hit of new Set(hits)) breach("§2", where, hit);
}

async function checkOverviewGateOpen(page, badge) {
  await checkOperationsBar(page, "/");
  try {
    await page
      .locator('[data-testid="attention-list"]')
      .waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    breach("§1", "/", "the gate-open fixture shows no list of entries");
    return;
  }
  const shape = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="attention-list"]');
    const entries = list
      ? [...list.querySelectorAll("[data-attention-id]")]
          .filter((marker) => marker.getClientRects().length > 0)
          .map((marker) => ({
            marker,
            row: marker.closest('[data-family-collection-row="true"]') ?? marker,
          }))
      : [];
    const surface = document.querySelector('[data-testid="attention-page"]');
    return {
      entries: entries.map(({ marker, row }) => ({
        id: marker.getAttribute("data-attention-id"),
        primary: row.querySelectorAll('[data-testid$="-primary"]').length,
        secondary: row.querySelectorAll('[data-testid$="-secondary"]').length,
        controls: row.querySelectorAll("a, button").length,
        text: (
          row.querySelector('[data-testid*="row-link-"]')?.getAttribute("aria-label") ?? ""
        ).trim(),
      })),
      headings: surface
        ? [...surface.querySelectorAll("h1, h2, h3, h4")].map((element) =>
            element.textContent.trim(),
          )
        : [],
      text: surface instanceof HTMLElement ? surface.innerText : "",
      calm: Boolean(document.querySelector('[data-testid="attention-calm"]')),
      status: document.querySelectorAll('[data-testid="attention-status"]').length,
    };
  });
  const expected = ATTENTION_ITEMS.map((item) => item.id);
  const actual = shape.entries.map((entry) => entry.id);
  if (actual.join("|") !== expected.join("|"))
    breach("§1", "/", `entries are ${actual.join(", ")} — the engine sent ${expected.join(", ")}`);
  const subjects = shape.entries.map((entry) => {
    const item = ATTENTION_ITEMS.find((candidate) => candidate.id === entry.id);
    return item?.subject ? `${item.subject.kind}:${item.subject.id}` : entry.id;
  });
  if (new Set(subjects).size !== subjects.length)
    breach("§12", "/", "two entries about one subject — two places to act on it");
  for (const entry of shape.entries) {
    if (entry.primary !== 1)
      breach("§1", `/ · ${entry.id}`, `${entry.primary} primary actions instead of exactly one`);
    if (entry.secondary > 1)
      breach("§1", `/ · ${entry.id}`, `${entry.secondary} secondary links instead of at most one`);
    if (entry.controls > 2)
      breach("§1", `/ · ${entry.id}`, `${entry.controls} controls on one entry`);
    if (!/seit .+\.$/.test(entry.text))
      breach("§5", `/ · ${entry.id}`, `not one sentence ending in "seit …": "${entry.text}"`);
  }
  if (badge && Number(badge.count) !== shape.entries.length)
    breach("§8.1", "/ · nav-overview-count", `badge ${badge.count}, list ${shape.entries.length}`);
  if (badge && badge.stopped !== "true")
    breach("§8.1", "/ · nav-overview-count", "an entry is stopped and the badge is not red");
  for (const heading of shape.headings)
    if (/\d/.test(heading))
      breach("§1, §12", `/ · heading "${heading}"`, "a count in a heading — the badge owns it");
  if (shape.text.includes(ENGINE_DETAIL))
    breach("§5", "/", "the engine's wording stands on an entry — it belongs in the review sheet");
  if (shape.calm) breach("§1", "/", '"Alles erledigt" beside open entries');
  if (shape.status > 0)
    breach("§12", "/", "a status line beside the entries repeats what they already say");
  const healthy = (shape.text.match(/\bGesund\b/g) ?? []).length;
  if (healthy > 1) breach("§12", "/", `"Gesund" stands ${healthy} times`);
}

async function checkOverviewCalm(page) {
  const empty = page.locator('[data-testid="attention-empty"]:visible');
  try {
    await empty.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    breach(
      "§1",
      "/ (calm)",
      `nothing is open, and the page does not say "${german("overview.count.none")}"`,
    );
    return;
  }
  await checkOperationsBar(page, "/ (calm)");
  const shape = await page.evaluate(() => {
    const text = (element) =>
      element instanceof HTMLElement ? element.innerText.replace(/\s+/g, " ").trim() : null;
    const shown = [...document.querySelectorAll('[data-testid="attention-empty"]')].find(
      (element) => element.getClientRects().length > 0,
    );
    return {
      section: text(shown),
      summary: text(
        document.querySelector('[data-testid="overview-summary"] [data-slot="summary-line-text"]'),
      ),
      history: text(document.querySelector('[data-testid="attention-history"]')),
      status: document.querySelectorAll('[data-testid="attention-status"]').length,
      entries: document.querySelectorAll('[data-testid="attention-list"] [data-attention-id]')
        .length,
      badge: Boolean(document.querySelector('[data-testid="nav-overview-count"]')),
      unread: Boolean(document.querySelector('[data-testid="attention-unread"]')),
      body: document.body.innerText,
    };
  });
  const none = german("overview.count.none");
  if (shape.section !== none)
    breach("§1, §8.6", "/ (calm)", `"Braucht dich" reads "${shape.section}" instead of "${none}"`);
  const zero = german("overview.count.other", { count: 0 });
  if (shape.summary !== zero)
    breach("§1", "/ (calm)", `the summary reads "${shape.summary}" instead of "${zero}"`);
  if (shape.history !== german("overview.history.link"))
    breach("§8.5", "/ (calm)", `the way to the history reads "${shape.history}"`);
  if (shape.status > 0) breach("§1, §8.6", "/ (calm)", `${shape.status} status lines`);
  if (shape.entries > 0) breach("§1", "/ (calm)", "an entry although nothing is open");
  if (shape.badge) breach("§8.1", "/ (calm)", "a badge although nothing is open");
  if (shape.unread) breach("§1", "/ (calm)", "a source is called unreadable in the calm fixture");
  if (shape.body.includes(german("overview.calm")))
    breach(
      "§1",
      "/ (calm)",
      `"${german("overview.calm")}" stands beside "${none}" — one calm line`,
    );
  const healthy = (shape.body.match(/\bGesund\b/g) ?? []).length;
  if (healthy > 1) breach("§12", "/ (calm)", `"Gesund" stands ${healthy} times`);
}

async function checkOverviewFailedSource(page) {
  try {
    await page
      .locator('[data-testid="attention-unread"]')
      .waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    breach("§1, §12", "/ (failed source)", "a source failed and the page does not say which");
    return;
  }
  await checkOperationsBar(page, "/ (failed source)");
  const shape = await page.evaluate(() => ({
    body: document.body.innerText,
    unread: document.querySelector('[data-testid="attention-unread"]')?.textContent ?? "",
    status: document.querySelectorAll('[data-testid="attention-status"]').length,
    summary:
      document.querySelector('[data-testid="overview-summary"] [data-slot="summary-line-text"]')
        ?.textContent ?? "",
  }));
  for (const key of ["overview.calm", "overview.count.none"])
    if (shape.body.includes(german(key)))
      breach(
        "§1, §12",
        "/ (failed source)",
        `"${german(key)}" although a source could not be read`,
      );
  if (/\d/.test(shape.summary))
    breach("§1, §12", "/ (failed source)", `counts over the gap: "${shape.summary}"`);
  if (!shape.unread.includes(german("overview.source.connectors")))
    breach("§1", "/ (failed source)", `the unread source is not named: "${shape.unread}"`);
  if (shape.status > 0)
    breach("§12", "/ (failed source)", "a health line stands over an incomplete answer");
}

async function checkNoZeroKpiTile(page, where) {
  const zeros = await page.evaluate(
    () =>
      [...document.querySelectorAll("[data-family-kpi-id]")].filter(
        (tile) => tile.getAttribute("data-family-kpi-value") === "0",
      ).length,
  );
  if (zeros > 0) breach("§1", where, `${zeros} KPI tile(s) showing 0`);
}

async function checkOperationsBar(page, where) {
  const bar = page.locator('[data-testid="operations-bar"] [data-figure-state]');
  try {
    await bar.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    breach("§1", where, "no operations bar on the Übersicht");
    return;
  }
  const shape = await page.evaluate(() => {
    const barElement = document.querySelector('[data-testid="operations-bar"]');
    const figures = [...(barElement?.querySelectorAll("[data-figure-state]") ?? [])];
    const below = document.querySelector(
      '[data-testid="attention-list"], [data-testid="attention-calm"], [data-testid="attention-unread"]',
    );
    const switcher = document.querySelector(
      '[data-testid="overview-summary"] [data-testid="operations-window"]',
    );
    return {
      figures: figures.map((figure) => ({
        id: figure.getAttribute("data-testid"),
        state: figure.getAttribute("data-figure-state"),
        text: (figure.textContent ?? "").replace(/\s+/g, " ").trim(),
        label: (figure.querySelector("p")?.textContent ?? "").trim(),
        pressure: figure.getAttribute("data-budget-pressure"),
        href: figure.querySelector("a")?.getAttribute("href") ?? null,
      })),
      tops: [...new Set(figures.map((figure) => Math.round(figure.getBoundingClientRect().top)))],
      overflow: barElement ? barElement.scrollWidth > barElement.clientWidth + 1 : false,
      first:
        barElement && below
          ? Boolean(barElement.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING)
          : null,
      switchFirst:
        barElement && switcher
          ? Boolean(switcher.compareDocumentPosition(barElement) & Node.DOCUMENT_POSITION_FOLLOWING)
          : null,
      options: switcher
        ? [...switcher.querySelectorAll("button")].map((button) => ({
            text: (button.textContent ?? "").trim(),
            pressed: button.getAttribute("aria-checked") ?? button.getAttribute("aria-pressed"),
          }))
        : null,
    };
  });
  const expected = ["runs", "successRate", "connectorHealth", "budget"].map(
    (id) => `operations-figure-${id}`,
  );
  if (shape.figures.map((figure) => figure.id).join("|") !== expected.join("|"))
    breach("§1", where, `the bar holds ${shape.figures.map((figure) => figure.id).join(", ")}`);
  if (shape.tops.length !== 1 && shape.tops.length !== 2)
    breach("§1", where, `the four figures stand in ${shape.tops.length} rows, not one or two`);
  if (shape.overflow) breach("§1", where, "the operations bar scrolls sideways");
  const byId = Object.fromEntries(shape.figures.map((figure) => [figure.id, figure]));
  const budget = byId["operations-figure-budget"];
  if (budget?.state === "value") {
    if (!/Nutzung/.test(budget.label) || !/Monat/.test(budget.label))
      breach("§1", `${where} · budget`, `"${budget.label}" is not the month's usage`);
    if (!/mind\. 87,22\s*\$/.test(budget.text))
      breach("§1", `${where} · budget`, `"${budget.text}" does not lead with the month's money`);
    if (!/27\s*%/.test(budget.text) || !/150 Mio\. Token/.test(budget.text))
      breach("§1", `${where} · budget`, `"${budget.text}" is not the month's share of the cap`);
    if (!/109,5 Mio\. übrig/.test(budget.text) || budget.pressure !== "ample")
      breach("§1", `${where} · budget`, `"${budget.text}" lacks the remainder or its state`);
  } else if (budget) breach("§1", `${where} · budget`, `reads "${budget.text}" (${budget.state})`);
  if (shape.first === false)
    breach("§1", where, "the operations bar stands below the attention list");
  if (!shape.options) breach("§1", where, "no window switch on the summary line");
  else {
    if (shape.switchFirst === false)
      breach("§1", where, "the window switch stands below the figures it chooses for");
    const labels = shape.options.map((option) => option.text).join(" / ");
    if (labels !== "24 Std / 7 Tage") breach("§1", `${where} · window`, `offers ${labels}`);
    if (shape.options[0]?.pressed !== "true")
      breach("§1", `${where} · window`, "24 hours is not the window chosen by default");
  }
  for (const figure of shape.figures) {
    const onward = figure.state === "uncapped" && figure.id === "operations-figure-budget";
    if (figure.state !== "value" && !onward && figure.href)
      breach("§1", `${where} · ${figure.id}`, `"${figure.text}" carries a link to nothing counted`);
    if (!figure.href) continue;
    const target = new URL(figure.href, "http://stand");
    const query = target.searchParams;
    const windowed =
      figure.id === "operations-figure-connectorHealth"
        ? query.get("health") === "not_ok"
        : figure.id === "operations-figure-budget"
          ? figure.state === "uncapped"
            ? query.get("leaf") === "tokens.monthly_budget"
            : target.pathname.endsWith("/usage")
          : Boolean(query.get("started_from") && query.get("started_to"));
    if (!windowed)
      breach("§10.1", `${where} · ${figure.id}`, `links to ${figure.href} — not the same window`);
    if (figure.id === "operations-figure-successRate" && query.get("status") !== "failed")
      breach("§10.1", `${where} · ${figure.id}`, "the rate does not open the failed runs");
  }
}

async function checkUsageMirrorsNoFigures(page) {
  const shape = await page.evaluate(() => ({
    kpis: document.querySelectorAll("[data-family-kpi-id]").length,
    bar: document.querySelectorAll('[data-testid="operations-bar"], [data-testid="usage-summary"]')
      .length,
  }));
  if (shape.kpis > 0 || shape.bar > 0)
    breach("§0.1", "/usage", "Nutzung shows the operating figures a second time");
}

async function openReview(context, id) {
  const page = await context.newPage();
  await stand.visit(page, `?review=${id}`);
  await page
    .locator('[data-testid="attention-review-body"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  return page;
}

async function checkReviewSheet(context) {
  const where = `/?review=workflow:…`;
  const page = await openReview(context, `workflow:${ID}`);
  try {
    const shape = await page.evaluate(() => {
      const sheet = document.querySelector('[data-testid="attention-review"]');
      return {
        queues: sheet ? sheet.querySelectorAll('[data-family-slot="queue"]').length : 0,
        cards: sheet ? sheet.querySelectorAll("article[data-decision-key]").length : 0,
        detail: document.querySelector('[data-testid="attention-review-detail"]'),
        detailMarked: document
          .querySelector('[data-testid="attention-review-detail"]')
          ?.getAttribute("data-engine-wording"),
        detailText:
          document.querySelector('[data-testid="attention-review-detail"]')?.textContent ?? "",
      };
    });
    if (shape.queues !== 1) breach("§8.5a", where, `${shape.queues} queues in the sheet`);
    if (shape.cards === 0) breach("§8.5a", where, "the sheet holds no decision card");
    if (shape.detailMarked !== "true" || !shape.detailText.includes(ENGINE_DETAIL))
      breach("§5", where, "the engine's wording is missing or not marked as the engine's");
    await checkCorrectionTitles(page, where);
    await checkNoIdentifiers(page, `${where} · sheet`);
    await checkNothingSettled(page, where, '[data-testid="attention-review"]');
  } finally {
    await page.close();
  }
  const skills = await openReview(context, "skills");
  try {
    if ((await skills.locator('article[data-decision-key^="skill:"]').count()) === 0)
      breach("§8.5a", "/?review=skills", "the skills sheet holds no skill proposal");
    await checkNothingSettled(skills, "/?review=skills", '[data-testid="attention-review"]');
  } finally {
    await skills.close();
  }
}

const german = (key, values) => interpolate(CATALOGS.de[key], values);

const engineOpenApi = JSON.parse(
  readFileSync(
    new URL("../packages/cli-core/src/engine-api/openapi.json", import.meta.url),
    "utf8",
  ),
);

const CANDIDATE_SCHEMAS = ["PatchCandidate", "SkillCandidate"];

function candidateStates(schema) {
  const properties = engineOpenApi.components?.schemas?.[schema]?.properties;
  return properties?.status?.enum ?? properties?.state?.enum ?? [];
}

const CANDIDATE_STATES = [...new Set(CANDIDATE_SCHEMAS.flatMap(candidateStates))].sort();

const OPEN_STATES = ["open", "proposed"];
const SETTLED_STATES = CANDIDATE_STATES.filter((state) => !OPEN_STATES.includes(state));

const SETTLED_STATUS_KEYS = [
  ...SETTLED_STATES.map((state) => `status.${state}`),
  "status.abandoned",
  "status.aborted",
  "status.archived",
  "status.cancelled",
  "status.completed",
  "status.succeeded",
];

const SETTLED_PROSE_KEYS = [
  "status.expired",
  "decisions.expired",
  "tool.outcome.done",
  "tool.status.approvalResponded",
];

const PROSE_WORDS = [
  ["Entschieden", "unbound prose — the family's word, nowhere in this console"],
  ["Zurückgestellt", "unbound prose — the family's word, nowhere in this console"],
  ["Für später erinnert", "unbound prose — the counter line's own wording"],
  ["Decided", "unbound prose"],
  ["Deferred", "unbound prose"],
  ["Snoozed", "unbound prose"],
  ["Dismissed", "unbound prose"],
  ["Discarded", "unbound prose"],
  ["Settled", "unbound prose"],
];

const SETTLED_WORDS = new Map();
for (const key of [...SETTLED_STATUS_KEYS, ...SETTLED_PROSE_KEYS])
  for (const locale of ["de", "en"]) {
    const label = CATALOGS[locale]?.[key];
    if (!label) continue;
    const seen = SETTLED_WORDS.get(label);
    SETTLED_WORDS.set(
      label,
      seen === undefined ? `${key} · ${locale}` : `${seen}, ${key} · ${locale}`,
    );
  }
for (const [word, why] of PROSE_WORDS) if (!SETTLED_WORDS.has(word)) SETTLED_WORDS.set(word, why);

function assertSettledAlphabetIsCurrent() {
  const missing = [];
  if (CANDIDATE_STATES.length === 0)
    missing.push(
      `no status enum on ${CANDIDATE_SCHEMAS.join(" or ")} in packages/cli-core/src/engine-api/openapi.json`,
    );
  if (SETTLED_STATES.length === 0)
    missing.push(`${CANDIDATE_STATES.join(", ") || "nothing"} — not one settled state among them`);
  for (const key of [...SETTLED_STATUS_KEYS, ...SETTLED_PROSE_KEYS])
    for (const locale of ["de", "en"]) {
      const label = CATALOGS[locale]?.[key];
      if (!label) missing.push(`${key} — no ${locale} entry in apps/cockpit/src/lib/i18n.ts`);
    }
  if (missing.length === 0) return;
  console.error(
    "Convention check NOT MEASURED: the §8.5 alphabet no longer covers this console's own words",
    "\n        for finished work. A rule whose vocabulary has drifted reports nothing and passes.",
    `\n        ${missing.join("\n        ")}`,
    "\n        Restore the key(s), or say in SETTLED_STATUS_KEYS / SETTLED_PROSE_KEYS that the word is gone,\n        and run again.",
  );
  process.exit(2);
}

const COUNT_SEPARATOR = "[ \\u00a0:·•|()\\[\\]]{0,3}";

function countedWith(text, word) {
  const literal = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit =
    new RegExp(`(^|[^\\p{L}])${literal}${COUNT_SEPARATOR}\\d`, "u").exec(text) ??
    new RegExp(`\\d${COUNT_SEPARATOR}${literal}([^\\p{L}]|$)`, "u").exec(text);
  if (hit === null) return null;
  const from = Math.max(0, hit.index - 30);
  return `${from === 0 ? "" : "…"}${text.slice(from, from + 130).replace(/\n/g, " ⏎ ")}…`;
}

const folded = (root) =>
  `${root} [aria-expanded="false"]:not([aria-haspopup]):not([role="combobox"])`;

async function unfoldDecisions(page, root) {
  return page.evaluate(
    async ({ root, selector }) => {
      const settle = () =>
        new Promise((done) =>
          setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 0),
        );
      const pressed = new WeakSet();
      for (let step = 0; step < 120; step += 1) {
        for (const details of document.querySelectorAll(`${root} details:not([open])`))
          details.open = true;
        const next = [...document.querySelectorAll(selector)].find(
          (element) => element instanceof HTMLElement && !pressed.has(element),
        );
        if (!next) return 0;
        pressed.add(next);
        next.click();
        await settle();
      }
      return [...document.querySelectorAll(selector)].filter((element) => !pressed.has(element))
        .length;
    },
    { root, selector: folded(root) },
  );
}

async function checkNothingSettled(page, where, root) {
  const unopened = await unfoldDecisions(page, root);
  if (unopened > 0)
    throw new NichtGemessen(
      `${where} · §8.5: ${unopened} folded section(s) were never opened — Radix does not mount a ` +
        "closed Collapsible, so what stands inside them was not in the DOM to be read. The rule " +
        "was not measured on this page.",
    );

  const found = await page.evaluate(
    ({ words, openStates, root }) => {
      const surface = document.querySelector(root);
      if (!surface) return null;
      const headings = [...surface.querySelectorAll("h1, h2, h3, h4, summary")]
        .map((element) => element.innerText.trim())
        .filter((text) => words.some((word) => text === word || text.startsWith(`${word} `)));
      const cards = [...surface.querySelectorAll("article[data-state]")]
        .map((element) => element.getAttribute("data-state") ?? "")
        .filter((state) => !openStates.includes(state));
      const controls = [...surface.querySelectorAll("button, [role='tab'], a")]
        .map((element) => element.innerText.trim())
        .filter((text) => words.some((word) => text === word));
      const stateless = [...surface.querySelectorAll("article[data-decision-key]")].filter(
        (element) => !element.hasAttribute("data-state"),
      ).length;
      const text =
        document.body instanceof HTMLElement
          ? document.body.innerText.replace(/[^\S\n]+/g, " ")
          : "";
      return { headings, cards, controls, stateless, text };
    },
    { words: [...SETTLED_WORDS.keys()], openStates: OPEN_STATES, root },
  );
  if (found === null) {
    breach("§8.5", where, "the surface did not mount, nothing about it was measured");
    return;
  }
  for (const heading of found.headings)
    breach("§8.5", where, `section "${heading}" holds settled work among open decisions`);
  for (const state of found.cards)
    breach(
      "§8.5",
      where,
      `a position renders with data-state="${state}" — not one of ${OPEN_STATES.join(", ")}`,
    );
  for (const control of found.controls)
    breach("§8.5", where, `the control "${control}" puts the queue into a past state`);
  if (found.stateless > 0)
    breach(
      "§8.5",
      where,
      `${found.stateless} positions carry no data-state — their state stays unmeasured`,
    );
  if (found.text.length === 0)
    throw new NichtGemessen(
      `${where} · §8.5: the page rendered no text at all, so the one shape the other four cannot ` +
        "see — a settled word standing beside a figure — was not looked for.",
    );
  for (const [word, provenance] of SETTLED_WORDS) {
    const hit = countedWith(found.text, word);
    if (hit !== null)
      breach(
        "§8.5",
        `${where} · the rendered text of the page`,
        `"${word}" (${provenance}) stands beside a figure — a count of what is over: ${hit}`,
      );
  }
}

async function checkHistoryLink(page) {
  const shape = await page.evaluate(() => {
    const links = [
      ...document.querySelectorAll('[data-testid="attention-page"] a[href*="/audit"]'),
    ].filter((link) => !link.closest('[data-testid="operations-bar"]'));
    const sentence = document.querySelector('[data-testid="attention-history"]');
    return {
      count: links.length,
      href: links[0]?.getAttribute("href") ?? null,
      text: sentence instanceof HTMLElement ? sentence.innerText.replace(/\s+/g, " ").trim() : null,
    };
  });
  if (shape.count === 0) {
    breach("§8.5", "/", "no way from Übersicht to the recorded history");
    return;
  }
  if (shape.count !== 1)
    breach("§8.5", "/", `${shape.count} ways to the history instead of exactly one`);
  const expected = german("overview.history.link");
  if (shape.text !== expected)
    breach("§5", "/ · attention-history", `reads "${shape.text}" instead of "${expected}"`);
  if (!(shape.href ?? "").includes("scope=decisions"))
    breach(
      "§8.5",
      "/ · attention-history",
      `the link leads to ${shape.href} — the log opens unfiltered and the history stays unfindable`,
    );
}

const AUDIT_DECISION_ROWS = [
  { action: "patch_candidate.approved", label: "Korrektur freigegeben" },
  { action: "skill_candidate.rejected", label: "Skill-Kandidat abgelehnt" },
];

async function checkDecisionHistoryIsReadable(page) {
  const filter = page.locator('[data-testid="audit-scope-filter"]');
  if ((await filter.count()) === 0) {
    breach("§8.5", "/audit", "no filter leads to the decision history");
    return;
  }
  const rows = await page.evaluate((expected) => {
    const text = document.body.innerText;
    return expected.map((row) => ({
      ...row,
      named: text.includes(row.label),
      raw: text.includes(row.action),
    }));
  }, AUDIT_DECISION_ROWS);
  for (const row of rows) {
    if (row.raw)
      breach(
        "§5",
        "/audit",
        `the log says "${row.action}" instead of a word in the reader's language`,
      );
    if (!row.named)
      breach(
        "§5",
        "/audit",
        `the decision "${row.label}" is recorded but never named on the surface`,
      );
  }
  const note = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="audit-scope-note"]');
    return element instanceof HTMLElement ? element.innerText.trim() : null;
  });
  if (!note)
    breach(
      "§12",
      "/audit",
      "the log does not say what it does NOT cover — a short page then reads as an all-clear",
    );
}

async function checkCorrectionTitles(page, where) {
  const toggles = page.locator('article[data-decision-key^="patch:"] [aria-expanded="false"]');
  const closed = await toggles.count();
  for (let index = 0; index < closed; index += 1) {
    try {
      await toggles.nth(index).click({ timeout: 2_000 });
    } catch {}
  }
  if (closed > 0) await page.waitForTimeout(300);

  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('article[data-decision-key^="patch:"]')].map((card) => {
      const testId = card.getAttribute("data-testid") ?? "";
      const title = card.querySelector(`[data-testid="${testId}-title"]`);
      const summary = card.querySelector(`[data-testid="${testId}-summary"]`);
      return {
        title: title instanceof HTMLElement ? title.innerText.trim() : null,
        summary: summary instanceof HTMLElement ? summary.innerText.trim() : null,
      };
    }),
  );
  if (cards.length === 0) {
    breach("§5", where, "no correction cards found, the title rule stays unmeasured");
    return;
  }
  const notes = PATCH_CANDIDATES.map((candidate) => candidate.diff.proposal.description);
  for (const card of cards) {
    if (!card.title || !/^Korrektur(: | für )/.test(card.title))
      breach("§5", `${where} · correction card`, `title "${card.title}"`);
    else if (notes.includes(card.title))
      breach("§5", `${where} · correction card`, `title is the engine's own change note`);
  }
  if (!cards.some((card) => card.summary && notes.includes(card.summary)))
    breach("§5", `${where} · correction card`, "the engine's change note is missing entirely");
}

const GERMAN_CAPTIONS = Object.values(CATALOGS.de).map(
  (value) =>
    new RegExp(
      `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, ".+?")}$`,
    ),
);

async function checkScreenReaderLanguage(page, where) {
  const captions = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll(".sr-only")]
        .map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean),
    ),
  ]);
  for (const caption of captions) {
    if (!GERMAN_CAPTIONS.some((pattern) => pattern.test(caption)))
      breach("§5", where, `screen-reader caption "${caption}" is not in the German catalogue`);
  }
}

async function checkActionLabels(page, where) {
  const generic = await page.evaluate(() => {
    const forbidden = new Set(["ok", "submit"]);
    return [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (rect.width === 0 || rect.height === 0) return false;
        const text = (
          element instanceof HTMLInputElement ? element.value : (element.textContent ?? "")
        ).trim();
        return forbidden.has(text.toLowerCase());
      })
      .map((element) => (element.textContent ?? element.getAttribute("value") ?? "").trim());
  });
  for (const label of generic) breach("§8.3", where, `Button beschriftet "${label}"`);
}

async function checkNoRefreshButton(page, where) {
  const offered = await page.evaluate(() => {
    const words = /^(aktualisieren|neu laden|refresh|reload)$/i;
    return [...document.querySelectorAll('[data-family-slot="list-surface"]')].flatMap((list) =>
      [...list.querySelectorAll('button, [role="button"]')]
        .filter((control) => {
          const name = (control.getAttribute("aria-label") ?? control.textContent ?? "").trim();
          return (
            words.test(name) ||
            /-refresh$/.test(control.getAttribute("data-testid") ?? "") ||
            control.querySelector("svg.lucide-refresh-cw") !== null
          );
        })
        .map(
          (control) =>
            `${list.getAttribute("data-family-collection-id") ?? "list"}: ${
              control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "button"
            }`,
        ),
    );
  });
  for (const control of offered)
    breach("§10", where, `list offers a refresh button (${control}); lists refresh themselves`);
}

async function checkNoIdentifiers(page, where) {
  const text = await page.locator("body").evaluate(textOutsidePayloads);
  const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  if (match) {
    const at = text.indexOf(match[0]);
    breach(
      "§5",
      where,
      `UUID-artiger Text: …${text.slice(Math.max(0, at - 30), at + 50).replace(/\s+/g, " ")}…`,
    );
  }
}

async function checkCuratedFieldLabels(page, where) {
  const raw = await page.evaluate(() =>
    [...document.querySelectorAll("dt")]
      .map((element) => element.textContent?.trim() ?? "")
      .filter((text) => /^[a-z][a-z0-9]*(?: [a-z0-9]+)*$/.test(text)),
  );
  for (const label of new Set(raw))
    breach("§5", where, `field name "${label}" is a passed-through engine key`);
}

async function checkNoRawTimestamps(page, where) {
  const text = await page.locator("body").innerText();
  const match = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  if (match) breach("§5", where, `raw timestamp on the surface: ${match[0]}…`);
}

const RESUME_LINE =
  "Du hast den Konnektor \u201eReporting API 1\u201c in prod entworfen, aber noch nicht geprobt.";

async function checkRightsPage(page) {
  const where = "/api-access";
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="api-access-tab-"][role="tab"]')].map(
      (tab) => tab.firstChild?.textContent?.trim() ?? "",
    ),
  );
  if (tabs.join("|") !== RIGHTS_TABS.join("|"))
    breach("§6", where, `the sections are ${tabs.join(", ") || "no tabs"}`);
  if ((await page.locator('[data-testid="api-access-index"]').count()) > 0)
    breach("§6", where, "an index of anchors stands above the sections instead of tabs");
  const intro = await page.evaluate(() => document.body.innerText);
  if (intro.includes(RIGHTS_INTRO)) breach("§5", where, "the page description is back");
  const badges = await page.evaluate(() =>
    Object.fromEntries(
      ["apps", "keys"].map((section) => [
        section,
        document
          .querySelector(`[data-testid="api-access-tab-${section}"] span`)
          ?.textContent?.trim() ?? null,
      ]),
    ),
  );
  for (const [section, expected] of Object.entries(RIGHTS_BADGES))
    if (badges[section] !== expected)
      breach(
        "§10",
        `${where} · ${section}`,
        `the tab says "${badges[section]}", not "${expected}"`,
      );

  for (const [section, ready] of [
    ["apps", '[data-testid="connected-clients"]'],
    ["keys", '[data-testid="api-keys"]'],
  ]) {
    await stand.visit(page, `api-access?section=${section}`);
    await page
      .locator(ready)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => {});
    const tab = await page.evaluate(
      (name) =>
        document
          .querySelector(`[data-testid="api-access-tab-${name}"]`)
          ?.getAttribute("aria-selected") ?? null,
      section,
    );
    if (tab !== "true")
      breach("§6", `${where}?section=${section}`, "the address does not open its tab");
    const shown = await page.evaluate(() => {
      const main = document.querySelector('[data-testid="admin-api-access"]');
      return {
        inner: document.body.innerText,
        content: main?.textContent ?? "",
      };
    });
    for (const text of [shown.inner, shown.content]) {
      if (/\bcurl\b/.test(text))
        breach("§5", `${where}?section=${section}`, "a curl command is on the page");
      if (text.includes("/v1/oauth/token"))
        breach("§5", `${where}?section=${section}`, "the token endpoint is on the page");
    }
    if (/Anbindung/i.test(shown.inner))
      breach("§5", `${where}?section=${section}`, 'the word "Anbindung" is on the page');
    for (const retired of ["Kontoverbindung", "Verbundene Anwendungen"])
      if (shown.inner.includes(retired))
        breach("§5", `${where}?section=${section}`, `the retired name "${retired}" is on the page`);
    if (section === "keys") await checkRightsKeys(page, where);
  }
}

const RIGHTS_TABS = ["Schlüssel", "Apps"];
const RIGHTS_INTRO = `Wer darf auf ${PRODUCT_NAME} zugreifen — und worauf greift ${PRODUCT_NAME} in deinem Namen zu.`;
const RIGHTS_BADGES = { apps: null, keys: "2" };

async function checkRightsKeys(page, where) {
  const scopeText = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="api-key-scopes-"]')]
      .map((element) => (element instanceof HTMLElement ? element.innerText : ""))
      .join("\n"),
  );
  if (!scopeText) breach("§11", where, "no key rights are shown");
  for (const scope of API_KEY_SCOPES.flat()) {
    if (scope !== "*" && scopeText.includes(scope))
      breach("§11", where, `raw scope string "${scope}" instead of a named right`);
  }
  if (!/verwaltet/.test(scopeText))
    breach("§11", where, 'a managing right is not marked "verwaltet"');
  const shape = await page.evaluate(() => {
    const keyRow = (name) =>
      [...document.querySelectorAll('[data-testid^="api-keys-row-"]')].find(
        (row) => row instanceof HTMLElement && row.innerText.includes(name),
      );
    const chip = (name) =>
      keyRow(name)?.querySelector("[data-key-state]")?.textContent?.trim() ?? null;
    return {
      taskList: document.querySelectorAll(
        '[data-testid="api-access-attention"], [data-testid="attention-list"]',
      ).length,
      expiredChip: chip("Altes Skript"),
      expiringChip: chip("Nachtlauf"),
      workingChip: chip("Reporting-Abruf"),
    };
  });
  if (shape.taskList > 0)
    breach("§1", where, "a second task list stands on API-Zugang — tasks live on Übersicht");
  if (shape.expiredChip !== "abgelaufen")
    breach("§11", `${where} · Altes Skript`, `the expired key says "${shape.expiredChip}"`);
  if (shape.expiringChip !== "läuft ab in 3 Tagen")
    breach("§11", `${where} · Nachtlauf`, `the key about to lapse says "${shape.expiringChip}"`);
  if (shape.workingChip !== null)
    breach("§11", `${where} · Reporting-Abruf`, `a working key carries "${shape.workingChip}"`);
}

async function checkWorkflowListHealth(page) {
  const where = "/workflows";
  await page
    .locator('[data-testid^="workflow-health-link-"]')
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => {});
  const shape = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="catalog-workflows"]');
    return {
      marks: document.querySelectorAll('[data-testid^="workflow-health-link-"]').length,
      wording: document.querySelectorAll('[data-testid="workflow-health-engine-wording"]').length,
      text: list instanceof HTMLElement ? list.innerText : "",
    };
  });
  if (shape.marks === 0) breach("§1", where, "an unhealthy workflow has no link to its failures");
  if (shape.wording > 0 || shape.text.includes("Wortlaut der Engine"))
    breach("§5", where, "a list row repeats the engine's wording — it lives on Übersicht");
  if (shape.text.includes("Drei Läufe in Folge fehlgeschlagen"))
    breach("§5", where, "a list row repeats the engine's reason");
}

async function checkAccessRedirect(context) {
  const page = await context.newPage();
  try {
    await stand.visit(page, "access");
    await page
      .locator('[data-testid="roles-section"]')
      .waitFor({ state: "visible", timeout: 15_000 });
    const url = new URL(page.url());
    if (url.pathname !== "/cockpit/people")
      breach("§6", "/access", `lands on ${url.pathname} instead of /cockpit/people`);
    if (url.searchParams.get("section") !== "roles")
      breach("§6", "/access", `lands on section=${url.searchParams.get("section")}, not roles`);
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="people-tab-"][role="tab"]')].map(
        (tab) => tab.textContent?.trim() ?? "",
      ),
    );
    if (tabs.join("|") !== "Personen|Rollen|Gruppen|Zugriffe")
      breach("§6", "/people", `sections are ${tabs.join(", ")}`);
  } catch (error) {
    if (error instanceof NichtGemessen) throw error;
    breach("§6", "/access", `the old address does not land: ${error.message}`);
  } finally {
    await page.close();
  }
}

async function checkConnectorCallback(context) {
  const where = "/connectors?failed=denied";
  const page = await context.newPage();
  try {
    await stand.visit(page, "connectors?failed=denied&name=wiki");
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "wiki" });
    await toast.first().waitFor({ state: "visible", timeout: 15_000 });
    const url = new URL(page.url());
    if (url.pathname !== "/cockpit/connectors")
      breach("§6", where, `lands on ${url.pathname} instead of /cockpit/connectors`);
    if (url.searchParams.has("failed") || url.searchParams.has("name"))
      breach("§6", where, "the callback's words stay in the address and repeat on reload");
  } catch (error) {
    if (error instanceof NichtGemessen) throw error;
    breach("§6", where, `the callback sentence is not shown: ${error.message}`);
  } finally {
    await page.close();
  }
}

async function checkConnectorSignIn(page) {
  const where = `/connectors/${ID}?tab=connection`;
  const state = await page.evaluate(() => {
    const read = (id) => {
      const element = document.querySelector(`[data-testid="${id}"]`);
      return element instanceof HTMLElement ? element.innerText.trim() : null;
    };
    return {
      bar: read("detail-connector-auth-state"),
      card: read("connector-auth-state"),
      renew: read("connector-renew-signin"),
      text: document.body.innerText,
    };
  });
  if (state.bar !== null)
    breach("§0.1", where, `the sign-in state also stands in a bar: "${state.bar}"`);
  if (!state.card?.includes("Abgelaufen"))
    breach("§11", where, `Anmeldung card reads "${state.card ?? "nothing"}"`);
  if (state.renew !== "Neu anmelden") breach("§1", where, 'no "Neu anmelden" for a lost sign-in');
  if (/Anbindung/i.test(state.text)) breach("§5", where, 'the word "Anbindung" is on the page');
}

async function checkModeGates(page) {
  const where = "/chat · Modus";
  const pill = page.locator('[data-testid="chat-permission"]');
  try {
    await pill.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    breach("§14", where, "no mode at the conversation");
    return;
  }
  if (await page.getByTestId("chat-mode-gates").isVisible())
    breach("§14", where, "the gate matrix stands permanently under the mode");
  await page.getByTestId("chat-mode-explain").click();
  const gates = page.getByTestId("chat-mode-gates");
  try {
    await gates.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    breach("§14", where, '"Was heißt das?" opens no gate matrix');
    return;
  }
  for (const row of ["chat-mode-gates-asks", "chat-mode-gates-outside"])
    if ((await page.getByTestId(row).count()) !== 1)
      breach("§14", where, `the matrix has no ${row.replace("chat-mode-gates-", "")} row`);
  await page.keyboard.press("Escape");
}

async function checkSidebarToggle(page, where) {
  const shape = await page.evaluate(() => {
    const triggers = [...document.querySelectorAll('[data-testid="sidebar-trigger"]')];
    const header = document.querySelector('[data-family-slot="page-header"]');
    return {
      count: triggers.length,
      inPageHeader: Boolean(header && triggers[0] && header.contains(triggers[0])),
      bar: Boolean(document.querySelector('[data-testid="cockpit-header"]')),
    };
  });
  if (shape.count !== 1) breach("§6", where, `${shape.count} sidebar toggles on one screen`);
  if (shape.bar) breach("§6", where, "an empty top bar stands above the page header");
  if (!shape.inPageHeader) breach("§6", where, "the sidebar toggle is not beside the page title");
}

async function checkResumeLine(page) {
  const line = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="chat-summary"]');
    return element instanceof HTMLElement ? element.innerText.trim() : null;
  });
  if (line === null) {
    breach("§5", "/chat · chat-summary", "no conversation state line");
    return;
  }
  if (line === RESUME_SUMMARY.one_sentence)
    breach("§5", "/chat · chat-summary", `the engine's sentence is reproduced verbatim: "${line}"`);
  else if (line !== RESUME_LINE)
    breach("§5", "/chat · chat-summary", `"${line}" instead of "${RESUME_LINE}"`);
}

const CATCH_ALL_PHRASES = ["Something went wrong", "Show Error"];

async function checkFailureState(page, where) {
  const seen = await page.evaluate(() => ({
    shell: Boolean(document.querySelector('[data-testid="cockpit-shell"]')),
    sidebar: Boolean(document.querySelector('[data-testid="cockpit-sidebar"]')),
    mounted: Boolean(document.querySelector('[data-testid="detail-knowledge"]')),
    back: Boolean(document.querySelector('[data-testid="detail-back"]')),
    state: Boolean(document.querySelector('[data-testid="knowledge-empty"]')),
    text: document.body.innerText,
  }));
  if (!seen.shell || !seen.sidebar)
    breach("§4", where, "the shell is gone — a catch-all screen replaced the cockpit");
  if (!seen.mounted) breach("§4", where, "the detail page does not mount");
  if (!seen.back) breach("§4", where, "no way back");
  if (!seen.state) breach("§4", where, "no designed state for the unreadable response");
  for (const phrase of CATCH_ALL_PHRASES) {
    if (seen.text.includes(phrase)) breach("§5", where, `englischer Auffangschirm: "${phrase}"`);
  }
}

async function checkStaleReview(context) {
  for (const [id, testId, words] of [
    [
      "workflow:018f4b4a-6d33-7b3a-9c2d-00000000dead",
      "attention-review-empty",
      "overview.sheet.nothingOpen",
    ],
    [
      "connector:018f4b4a-6d33-7b3a-9c2d-00000000dead",
      "attention-review-nothing",
      "overview.sheet.nothingToReview",
    ],
  ]) {
    const where = `/?review=${id.split(":")[0]}:… (stale)`;
    const page = await context.newPage();
    try {
      await stand.visit(page, `?review=${id}`);
      await page
        .locator(`[data-testid="${testId}"]`)
        .waitFor({ state: "visible", timeout: 15_000 });
      const text = await page.locator('[data-testid="attention-review"]').innerText();
      if (!text.includes(german(words)))
        breach("§1, §12", where, `the sheet does not say "${german(words)}"`);
      if (await page.locator('[data-testid="attention-review"] article[data-decision-key]').count())
        breach("§12", where, "a stale review shows another entry's decisions");
    } catch (error) {
      if (error instanceof NichtGemessen) throw error;
      breach("§1, §12", where, `the stale review never says it is empty: ${error.message}`);
    } finally {
      await page.close();
    }
  }
}

async function checkCatalogOpensInApp(context) {
  const page = await openPage(context, "workflows");
  try {
    const link = page.locator('[data-testid="data-table-row-link-0"]');
    await link.waitFor({ state: "visible", timeout: 15_000 });
    await page.evaluate(() => {
      window.__skSameDocument = true;
    });
    await link.click();
    await page
      .locator('[data-testid="detail-workflows"]')
      .waitFor({ state: "visible", timeout: 15_000 });
    if (!(await page.evaluate(() => window.__skSameDocument === true)))
      breach("§12", "/workflows · row link", "opening a record reloads the whole cockpit");
  } finally {
    await page.close();
  }
}

async function germanContext(browser, handler) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "de-DE",
  });
  await context.addInitScript(() => {
    localStorage.setItem("sk-cockpit-locale", "de");
    localStorage.setItem("sk-cockpit-theme", "light");
  });
  await context.route("**/v1/**", handler);
  return context;
}

async function checkOverviewUnreadable(browser) {
  const busy = apiMock(false);
  const context = await germanContext(browser, (route) =>
    new URL(route.request().url()).pathname === "/v1/attention"
      ? json(route, { code: "unavailable", message: "fixture refuses" }, 503)
      : busy(route),
  );
  const page = await openPage(context, "");
  try {
    await page
      .locator('[data-testid="attention-error"]:visible')
      .waitFor({ state: "visible", timeout: 15_000 });
    const body = await page.locator("body").innerText();
    for (const key of ["overview.calm", "overview.count.none"])
      if (body.includes(german(key)))
        breach("§1, §12", "/ (attention unreadable)", `"${german(key)}" although nothing was read`);
    const summary = await page
      .locator('[data-testid="overview-summary"] [data-slot="summary-line-text"]')
      .innerText()
      .catch(() => "");
    if (/\d/.test(summary))
      breach("§1, §12", "/ (attention unreadable)", `counts what it could not read: "${summary}"`);
  } catch (error) {
    if (error instanceof NichtGemessen) throw error;
    breach(
      "§1, §4",
      "/ (attention unreadable)",
      `the failed read is not shown as one: ${error.message}`,
    );
  } finally {
    await page.close();
    await context.close();
  }
}

async function checkReviewNotPermitted(browser) {
  const busy = apiMock(true);
  const context = await germanContext(browser, (route) =>
    new URL(route.request().url()).pathname === "/v1/cockpit/bootstrap"
      ? json(route, {
          ...BOOTSTRAP,
          permissions: BOOTSTRAP.permissions.filter(
            (permission) => !["workflow:read", "skill:read"].includes(permission),
          ),
        })
      : busy(route),
  );
  const page = await context.newPage();
  const where = "/?review=workflow:… (no workflow:read)";
  try {
    await stand.visit(page, `?review=workflow:${ID}`);
    await page
      .locator('[data-testid="attention-review-not-permitted"]')
      .waitFor({ state: "visible", timeout: 15_000 });
    const text = await page.locator('[data-testid="attention-review"]').innerText();
    if (!text.includes(german("overview.sheet.notPermitted")))
      breach("§5", where, "the refusal is not said in words");
  } catch (error) {
    if (error instanceof NichtGemessen) throw error;
    breach("§1, §4", where, `the sheet never says the reader may not see it: ${error.message}`);
  } finally {
    await page.close();
    await context.close();
  }
}

async function checkRowsOpenByTheirName(page, where) {
  const shape = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-family-collection-row="true"]')];
    return {
      rows: rows.length,
      openControls: rows.flatMap((row) =>
        [...row.querySelectorAll("a, button, [role='button']")]
          .filter(
            (control) =>
              /^Öffnen$/.test(control.textContent?.trim() ?? "") ||
              /-open-\d+$/.test(control.getAttribute("data-testid") ?? ""),
          )
          .map((control) => control.getAttribute("data-testid") ?? control.textContent?.trim()),
      ),
      tabStops: rows.filter((row) => row.getAttribute("tabindex") === "0").length,
      buttonCards: rows.filter((row) => row.tagName === "BUTTON" && row.querySelector("a, button"))
        .length,
      clickable: rows.filter((row) => row.classList.contains("cursor-pointer")).length,
      unnamedButtons: [...document.querySelectorAll('button[data-testid*="row-link-"]')].filter(
        (button) => {
          const label = button.getAttribute("aria-label")?.trim() ?? "";
          return label.length === 0 || label === button.textContent?.trim();
        },
      ).length,
      named: document.querySelectorAll(
        '[data-testid$="-row-link-0"], [data-testid$="-mobile-row-link-0"]',
      ).length,
    };
  });
  for (const control of new Set(shape.openControls))
    breach("§12", where, `a row carries an "Öffnen" control (${control}) beside its own link`);
  if (shape.tabStops > 0)
    breach("§12", where, `${shape.tabStops} rows are tab stops — the name link is the way in`);
  if (shape.buttonCards > 0)
    breach("§12", where, `${shape.buttonCards} mobile cards are buttons wrapping controls`);
  if (shape.unnamedButtons > 0)
    breach("§5", where, `${shape.unnamedButtons} row buttons are named only by their cell text`);
  if (shape.clickable > 0 && shape.named === 0)
    breach("§12", where, "rows open on click, but no row names itself with a link");
}

async function sweepDetailSurface(page, route) {
  if (route.includes("$")) {
    const already = page.locator('[role="dialog"][data-state="open"]');
    if ((await already.count()) > 0) {
      const where = `/${route} · detail view`;
      swept.push(where);
      await checkNoUnknownState(page, where);
      await checkActionLabels(page, where);
      await checkNoIdentifiers(page, where);
      await checkCuratedFieldLabels(page, where);
      await checkNoRawTimestamps(page, where);
      await checkScreenReaderLanguage(page, where);
      return;
    }
  }
  const opener = page.locator('[data-testid="data-table-row-link-0"]');
  if ((await opener.count()) === 0) {
    if ((await page.locator('[data-testid="data-table"]').count()) > 0)
      gap(`/${route} · detail surface`, "the list offers no row to open");
    return;
  }
  const listUrl = page.url();
  try {
    await opener.first().click();
  } catch (error) {
    throw new NichtGemessen(
      `/${route} · detail surface: the row would not open (${error.message}). The list offers one, ` +
        "so the surface exists and this run could not reach it — six rules were skipped on it, not " +
        "passed.",
      { cause: error },
    );
  }
  try {
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
  } catch (error) {
    throw new NichtGemessen(
      `/${route} · detail surface: it did not settle after opening (${error.message}). What would ` +
        "have been read is a surface still in motion, so it was not read — six rules were skipped " +
        "on it, not passed.",
      { cause: error },
    );
  }
  if (page.url() !== listUrl) return;

  const where = `/${route} · detail view`;
  const shown = await page
    .locator('[role="dialog"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!shown) {
    gap(where, "detail surface does not appear — the fixture serves no record for it");
    return;
  }
  try {
    await page
      .locator('[data-slot="skeleton"]')
      .first()
      .waitFor({ state: "detached", timeout: 8_000 });
  } catch (error) {
    throw new NichtGemessen(
      `${where}: still a skeleton after 8s. The surface is open and what could be read off it is ` +
        "its loading behaviour, not its words — six rules were skipped on it, not passed.",
      { cause: error },
    );
  }
  swept.push(where);
  await checkNoUnknownState(page, where);
  await checkActionLabels(page, where);
  await checkNoIdentifiers(page, where);
  await checkCuratedFieldLabels(page, where);
  await checkNoRawTimestamps(page, where);
  await checkScreenReaderLanguage(page, where);
}

class NichtGemessen extends Error {}

const stand = standAt({
  baseUrl,
  refuse: (satz, optionen) => new NichtGemessen(satz, optionen),
});

async function startPreview() {
  if (externalBaseUrl) {
    let response;
    try {
      response = await fetch(`${baseUrl}/cockpit/`);
    } catch (error) {
      throw new NichtGemessen(`${baseUrl}/cockpit/ was not reachable: ${error.message}`);
    }
    if (!response.ok)
      throw new NichtGemessen(`${baseUrl}/cockpit/ answered with HTTP ${response.status}`);
    return { server: null };
  }
  const server = spawn(
    "bunx",
    [
      "vite",
      "preview",
      "--config",
      "apps/cockpit/vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(previewPort),
      "--strictPort",
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/cockpit/`);
      if (response.ok) return { server };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  server.kill();
  throw new NichtGemessen(`preview server did not answer on ${baseUrl} within 60s`);
}

async function assertStandStillAnswers(cause) {
  if (browser === null) throw new NichtGemessen(cause.message, { cause });
  const page = await browser.newPage();
  try {
    await stand.visit(page, "", { waitUntil: "domcontentloaded" });
  } catch (error) {
    throw new NichtGemessen(
      `${error.message} The stand stopped being what it was while the sweep was running, so ` +
        "nothing after that point is a statement about the console. First symptom: " +
        `${cause.message}`,
      { cause },
    );
  } finally {
    await page.close();
  }
}

async function openPage(context, route) {
  const page = await context.newPage();
  const target = concreteRoute(route);
  await stand.visit(page, target);
  const marker = MOUNT_MARKERS[route] ?? `[data-testid="resource-${route}"]`;
  await page.locator(marker).waitFor({ state: "visible", timeout: 15_000 });
  return page;
}

async function checkCollectionDataStates(browser) {
  for (const scenario of ["loading", "empty", "error"]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "de-DE",
    });
    await context.addInitScript(() => {
      localStorage.setItem("sk-cockpit-locale", "de");
      localStorage.setItem("sk-cockpit-theme", "light");
    });
    await context.route("**/v1/**", apiMock(true));

    let releaseRead = () => {};
    const heldRead = new Promise((resolve) => {
      releaseRead = resolve;
    });
    await context.route("**/v1/workflows*", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET" || url.pathname !== "/v1/workflows")
        return route.fallback();
      if (scenario === "loading") await heldRead;
      if (scenario === "error")
        return json(
          route,
          { code: "fixture_unavailable", message: "temporarily unavailable" },
          503,
        );
      return json(route, { items: [], total: 0 });
    });

    const page = await context.newPage();
    try {
      await stand.visit(page, "workflows", { waitUntil: "domcontentloaded" });
      const state = page.locator(
        `[data-family-slot="data-state"][data-family-state="${scenario}"]`,
      );
      await state.first().waitFor({ state: "visible", timeout: 7_000 });
      if (scenario === "loading" && (await state.locator('[aria-busy="true"]').count()) === 0) {
        const selfBusy = await state.first().getAttribute("aria-busy");
        if (selfBusy !== "true")
          breach("§4 collection state", "/workflows loading", "no aria-busy loading surface");
      }
      if (scenario === "empty" && (await state.first().innerText()).trim().length < 12)
        breach("§4 collection state", "/workflows empty", "empty state has no explanatory copy");
      if (
        scenario === "error" &&
        (await state.first().locator('[data-testid="data-table-retry"]').count()) !== 1
      )
        breach("§4 collection state", "/workflows error", "error state has no single retry action");
    } catch (error) {
      breach(
        "§4 collection state",
        `/workflows ${scenario}`,
        `state not measurable: ${error.message}`,
      );
    } finally {
      releaseRead();
      await page.close();
      await context.close();
    }
  }
}

async function checkUnknownDecisionKind(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "de-DE",
  });
  await context.addInitScript(() => {
    localStorage.setItem("sk-cockpit-locale", "de");
    localStorage.setItem("sk-cockpit-theme", "light");
  });
  await context.route("**/v1/**", apiMock(true, { unknownDecisionKind: true }));
  const page = await openReview(context, `workflow:${ID}`);
  try {
    const where = "/?review=workflow:… unknown kind";
    if ((await page.locator('[data-testid^="review-decision-"]').count()) === 0)
      breach("§4, §8.8", where, "the sheet dropped the future kind or unmounted");
    const text = await page.locator('[data-testid="attention-review"]').innerText();
    if (text.includes("future_operator_choice"))
      breach("§5, §8.8", where, "raw future_operator_choice enum is visible");
  } finally {
    await page.close();
    await context.close();
  }
}

checkKonventionVersion();

assertSettledAlphabetIsCurrent();

let abbruch = null;
let server = null;
let browser = null;
let besuchteRouten = 0;
let routenDurchlaufen = false;
try {
  const preview = await startPreview();
  server = preview.server;

  browser = await chromium.launch({ headless: true });
  const schale = await browser.newPage();
  try {
    await stand.visit(schale, "", { waitUntil: "domcontentloaded" });
  } finally {
    await schale.close();
  }

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "de-DE",
  });
  await context.addInitScript(() => {
    localStorage.setItem("sk-cockpit-locale", "de");
    localStorage.setItem("sk-cockpit-theme", "light");
  });
  await context.route("**/v1/**", apiMock(true));

  const today = await openPage(context, "");
  await checkWordmark(today);
  await checkBrowserTitle(today);
  await checkFavicon(today);
  await checkRoleLabel(today);
  await checkAdminGroupName(today);
  await checkInstallationEntries(today);
  const badge = await checkOverviewNavEntry(today);
  await checkOverviewGateOpen(today, badge);
  await checkHistoryLink(today);
  await today.close();

  await checkReviewSheet(context);
  await checkStaleReview(context);
  await checkCatalogOpensInApp(context);

  const auditHistory = await context.newPage();
  await stand.visit(auditHistory, "audit?scope=decisions");
  await auditHistory
    .locator('[data-testid="resource-audit"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  await checkDecisionHistoryIsReadable(auditHistory);
  await auditHistory.close();

  const chat = await openPage(context, "chat");
  await checkResumeLine(chat);
  await checkModeGates(chat);
  await chat.close();

  const rights = await openPage(context, "api-access");
  await checkRightsPage(rights);
  await rights.close();
  const workflowList = await openPage(context, "workflows");
  await checkSidebarToggle(workflowList, "/workflows");
  await checkWorkflowListHealth(workflowList);
  await workflowList.close();
  await checkConnectorCallback(context);
  await checkAccessRedirect(context);

  const connector = await context.newPage();
  await stand.visit(connector, `connectors/${ID}?tab=connection`);
  await connector
    .locator('[data-testid="connector-credentials"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  await checkConnectorSignIn(connector);
  await connector.close();

  for (const route of ROUTES) {
    besuchteRouten += 1;
    console.error(`route ${besuchteRouten}/${ROUTES.length}: /${route}`);
    let page;
    try {
      page = await openPage(context, route);
    } catch (error) {
      if (error instanceof NichtGemessen) throw error;
      await assertStandStillAnswers(error);
      breach("§6", `/${route}`, `page does not mount: ${error.message}`);
      continue;
    }
    await checkNoUnknownState(page, `/${route}`);
    await checkActionLabels(page, `/${route}`);
    await checkNoRefreshButton(page, `/${route}`);
    await checkNoIdentifiers(page, `/${route}`);
    await checkCuratedFieldLabels(page, `/${route}`);
    await checkNoRawTimestamps(page, `/${route}`);
    await checkScreenReaderLanguage(page, `/${route}`);
    await checkNoZeroKpiTile(page, `/${route}`);
    if (route === "usage") await checkUsageMirrorsNoFigures(page);
    await checkRowsOpenByTheirName(page, `/${route}`);
    await sweepDetailSurface(page, route);
    await page.close();
  }
  routenDurchlaufen = true;
  await context.close();

  await checkCollectionDataStates(browser);
  await checkUnknownDecisionKind(browser);
  await checkOverviewUnreadable(browser);
  await checkReviewNotPermitted(browser);

  for (const failedAttentionSource of [null, "connectors"]) {
    const calm = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "de-DE",
    });
    await calm.addInitScript(() => {
      localStorage.setItem("sk-cockpit-locale", "de");
      localStorage.setItem("sk-cockpit-theme", "light");
    });
    await calm.route("**/v1/**", apiMock(false, { failedAttentionSource }));
    const calmToday = await openPage(calm, "");
    if (failedAttentionSource) await checkOverviewFailedSource(calmToday);
    else await checkOverviewCalm(calmToday);
    await checkNoZeroKpiTile(calmToday, "/ (calm)");
    await calmToday.close();
    await calm.close();
  }

  const broken = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "de-DE",
  });
  await broken.addInitScript(() => {
    localStorage.setItem("sk-cockpit-locale", "de");
    localStorage.setItem("sk-cockpit-theme", "light");
  });
  const busyMock = apiMock(true);
  await broken.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/v1/knowledge-sources/${ID}/chunks`) return json(route, { documents: [] });
    return busyMock(route);
  });
  const brokenPage = await broken.newPage();
  await stand.visit(brokenPage, `knowledge/${ID}`);
  await brokenPage.waitForTimeout(500);
  await checkFailureState(brokenPage, "/knowledge/… (Fixture mit unlesbarer Antwort)");
  await brokenPage.close();
  await broken.close();
} catch (error) {
  abbruch = error;
  if (!(error instanceof NichtGemessen)) {
    try {
      await assertStandStillAnswers(error);
    } catch (dead) {
      abbruch = dead instanceof NichtGemessen ? dead : error;
    }
  }
} finally {
  await browser?.close();
  server?.kill();
}

const nichtGemessen = abbruch instanceof NichtGemessen || (Boolean(abbruch) && !routenDurchlaufen);
const gescheitert = violations.length > 0 || Boolean(abbruch);
const report = gescheitert ? console.error : console.log;

const massstab = konventionVersionImRepo
  ? `COCKPIT-KONVENTION.md v${konventionVersionImRepo}`
  : "COCKPIT-KONVENTION.md (header line without a readable version)";
const pruefstand =
  stand.identity === null
    ? `${baseUrl} — WHOSE console answered there is unresolved, so nothing is said about what was measured`
    : externalBaseUrl
      ? `foreign stand at ${externalBaseUrl} · identity ${stand.identity} (from <meta name="${IDENTITY_META}"> of the served document)`
      : `the BUILT version — vite preview on ${baseUrl}, the stand the engine ships rather than the dev server · identity ${stand.identity} (from <meta name="${IDENTITY_META}"> of the served document)`;

report(
  `Standard: ${massstab} (header line of the repo copy) · this check is written by hand against v${KONVENTION_VERSION}`,
);
report(`Stand: ${pruefstand}`);
report("Language: de only (sk-cockpit-locale=de, browser locale de-DE)");
report(
  abbruch
    ? `Measured: incomplete — the run aborted at route ${besuchteRouten} of ${ROUTES.length} in the router table, ${ROUTES.length - besuchteRouten} were never looked at`
    : `Measured: ${ROUTES.length} routes from the router table` +
        (swept.length > 0
          ? `, plus ${swept.length} detail surface(s) without a route of their own (${swept.join(", ")})`
          : ", no detail surface without a route of its own"),
);
if (gaps.length > 0) {
  report(`Not measured: ${gaps.length}`);
  for (const { where, why } of gaps) report(`  ${where} — ${why}`);
}
report("");

function printViolations() {
  for (const { rule, where, actual } of violations) {
    console.error(`  ${rule} · ${where}\n      is: ${actual}`);
  }
}

if (abbruch) {
  console.error(
    nichtGemessen
      ? `Convention check NOT MEASURED: ${abbruch.message}\n` +
          "This run says NOTHING about the surface. What follows comes from the checks that need no\n" +
          "stand (§7, convention version) and from the routes reached before the abort; an empty list\n" +
          "here is not an acquittal but a measurement that did not happen.\n"
      : `Convention check ABORTED: ${abbruch?.message ?? String(abbruch)}\n` +
          "A run that could not finish measuring is not a passing run. What was found up to the abort\n" +
          "is below — everything after it is unmeasured, not clean.\n",
  );
  if (violations.length > 0) {
    console.error(
      nichtGemessen
        ? `Noted before the abort: ${violations.length} — not a work list, the run did not measure\n`
        : `Found before the abort: ${violations.length} breaches of ${massstab}\n`,
    );
    printViolations();
    console.error("");
  }
  console.error(abbruch?.stack ?? String(abbruch));
  process.exit(nichtGemessen ? 2 : 1);
}

if (violations.length === 0) {
  console.log(
    `Convention check passed: no breaches of ${massstab} on ${ROUTES.length} routes of the\n` +
      'built version, measured in German. What stands above under "Not measured" is not covered by this.',
  );
  process.exit(0);
}

console.error(`Convention check: ${violations.length} breaches of ${massstab}\n`);
printViolations();
process.exit(1);
