import { AuditAction } from "../../apps/engine/src/audit/types.ts";
import { leafSchemaMeta, listConfigLeaves } from "../../apps/engine/src/config/walk.ts";
import ENGINE_PERMISSIONS from "../../apps/engine/src/rbac/permissions.json" with { type: "json" };

const uuid = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
const runWorkflowId = "5b2e9c14-7a3d-4f68-b1e0-8c9d2a4f6e37";
const BLOCKED_WORKFLOW_ID = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const runConnectorId = "c3a8f1d2-6b4e-4c97-a5f0-1e2d3b4c5a69";
const runVersionId = "9d4f6a21-3c8b-4e05-b7a2-6f1e0d9c8b34";
const hostileAuthority = {
  id: "e7b1c4d9-2a6f-4b83-9c05-d3e8f1a2b4c6",
  workflow_version_id: "8a3d5f7b-1c9e-4d26-a0b8-f4e6c2d1a9b3",
  connector_id: "2f9e8d7c-6b5a-4f39-8e21-0d1c2b3a4f5e",
  created_by: "b6c5d4e3-f2a1-4098-8765-4a3b2c1d0e9f",
  tenant_id: "4c3b2a1f-0e9d-4c8b-9a76-5f4e3d2c1b0a",
};
const CUSTOM_ROLE_ID = "018f4b4a-6d33-7b3a-9c2d-00000000c0de";
const REVIEWER_ID = "018f4b4a-6d33-7b3a-9c2d-0000000000a2";
const SYSTEM_ACCOUNT_ID = "018f4b4a-6d33-7b3a-9c2d-0000000005a1";
const routes = [
  "",
  `?review=workflow:${uuid}`,
  "chat",
  "workflows",
  "?runs=all",
  `?run=${uuid}`,
  `workflows/${uuid}`,
  "connectors",
  `connectors/${uuid}`,
  "connectors?health=not_ok",
  "knowledge",
  "skills",
  "files",
  `knowledge/${uuid}`,
  `skills/${uuid}`,
  `files/${uuid}`,
  "audit",
  "audit?scope=all&action=patch_candidate.approved,patch_candidate.auto_applied,patch_candidate.rejected",
  "usage",
  "people",
  "people?section=roles",
  "people?section=groups",
  "people?section=grants",
  "access",
  "api-access",
  "api-access?section=keys",
  "settings?tab=notifications",
  "settings",
  "settings?section=auth",
];

const sweepList = (name) => process.env[name]?.split(/\s+/).filter(Boolean) ?? null;
const ROUTE_FILTER = sweepList("COCKPIT_SWEEP_ROUTES");
const focused = ROUTE_FILTER !== null;
const sweptRoutes = focused
  ? routes.filter((route) =>
      ROUTE_FILTER.includes(route === "" ? "/" : route.replaceAll(uuid, "$id")),
    )
  : routes;
const STAND_FILTER = sweepList("COCKPIT_SWEEP_STANDS") ?? [];
const standOn = (stand) => !focused || STAND_FILTER.includes(stand.name);

const AUDIT_FIXTURE_ROWS = [
  {
    action: "patch_candidate.approved",
    resource_type: "patch_candidate",
    result: "success",
    before: { empfaenger: ["team@example.com"], format: "pdf", anhang: true },
    after: { empfaenger: ["team@example.com", "leitung@example.com"], format: "pdf", anhang: true },
  },
  {
    action: "skill_candidate.rejected",
    resource_type: "skill_candidate",
    result: "success",
  },
  {
    action: "workflow.updated",
    resource_type: "workflow",
    result: "success",
    metadata: { geaenderte_schritte: 2, wiederholungen: 0, benachrichtigt: false, hinweis: "" },
  },
  { action: "connector.invoked", resource_type: "connector", result: "denied" },
  {
    action: "settings.changed",
    resource_type: "settings",
    result: "error",
    before: { aufbewahrung_tage: 30 },
  },
  {
    action: "mcp_oauth.client_registered",
    resource_type: "mcp_oauth_client",
    result: "success",
    actor_type: "system",
    metadata: { anwendung: "Berichtsportal", zugriffsrechte: ["mcp:read"] },
  },
  {
    action: "schedule.admission.changed",
    resource_type: "workflow_schedule",
    result: "denied",
    before: { zulassung: "erlaubt" },
    after: { zulassung: "angehalten" },
  },
  {
    action: "patch_candidate.closed_inapplicable",
    resource_type: "patch_candidate",
    result: "success",
    actor_type: "system",
    metadata: { grund: "no_change" },
  },
];

function assertAuditFixtureActionsAreReal() {
  const known = new Set(Object.values(AuditAction));
  if (known.size === 0) {
    console.error(
      "Cockpit visual sweep NOT TAKEN — `AuditAction` came back empty, so every fixture row would",
      "\n        pass by default. The enum moved in apps/engine/src/audit/types.ts.",
    );
    process.exit(2);
  }
  const invented = AUDIT_FIXTURE_ROWS.map((row) => row.action).filter(
    (action) => !known.has(action),
  );
  if (invented.length > 0) {
    console.error(
      "Cockpit visual sweep NOT TAKEN — the audit fixture writes verbs the engine cannot:",
      `\n        ${invented.join(", ")}`,
      `\n        Not one of the ${known.size} values of \`AuditAction\` (apps/engine/src/audit/types.ts).`,
      "\n        A fixture that invents a verb photographs a world that does not exist.",
    );
    process.exit(2);
  }
}

const conversation = {
  id: uuid,
  tenant_id: uuid,
  target_workflow_id: null,
  target_connector_id: null,
  status: "active",
  owner_id: uuid,
  model: "test-model",
  title: "Monatsreport reparieren",
  created_at: "2026-08-01T09:00:00.000Z",
  updated_at: "2026-08-10T09:00:00.000Z",
  last_message_role: "assistant",
  last_message_excerpt: `{"tool":"run_workflow","output":{"execution_id":"${uuid}"}}`,
};

const AUDIT_FIXTURE_ENTRIES = Array.from({ length: 24 }, (_, index) => {
  const row = AUDIT_FIXTURE_ROWS[index % AUDIT_FIXTURE_ROWS.length];
  return {
    id: index === 0 ? uuid : `audit-${index}`,
    ts: new Date(Date.parse(conversation.updated_at) - index * 120_000).toISOString(),
    tenant_id: uuid,
    actor_type: row.actor_type ?? ["user", "system_account", "system", "user"][index % 4],
    actor_id:
      index % 4 === 2
        ? null
        : (row.actor_type ?? ["user", "system_account", "system", "user"][index % 4]) ===
            "system_account"
          ? SYSTEM_ACCOUNT_ID
          : uuid,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_type === "settings" ? null : uuid,
    result: row.result,
    trace_id: index % 3 === 0 ? null : `cli-949cacce25ff43${70 + (index % 10)}`,
    ip: index % 3 === 0 ? null : "203.0.113.42",
    user_agent: index % 3 === 0 ? null : "SubKit-CLI (macOS)",
    reason:
      row.result === "denied"
        ? "Rolle deckt skill:write nicht ab."
        : row.action === "skill_candidate.rejected"
          ? "Deckt sich mit einem schon freigegebenen Skill."
          : null,
    before: row.before ?? null,
    after: row.after ?? null,
    metadata: row.metadata ?? {},
  };
});

const AUDIT_PAGING_TAIL = Array.from({ length: 60 }, (_, offset) => {
  const index = AUDIT_FIXTURE_ENTRIES.length + offset;
  return {
    ...AUDIT_FIXTURE_ENTRIES[0],
    id: `audit-${index}`,
    ts: new Date(Date.parse(conversation.updated_at) - index * 120_000).toISOString(),
    action: "patch_candidate.approved",
    resource_type: "patch_candidate",
    result: "success",
    reason: null,
  };
});

const AUDIT_PAGED_ENTRIES = [...AUDIT_FIXTURE_ENTRIES, ...AUDIT_PAGING_TAIL];

function pageOf(items, url) {
  const limit = Number(url.searchParams.get("limit") ?? "0");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  return limit > 0 ? items.slice(offset, offset + limit) : items.slice(offset);
}

const SWEEP_NOW = Date.now();

const conversations = Array.from({ length: 32 }, (_, index) => {
  const waiting = index % 3 === 1;
  return {
    ...conversation,
    id: index === 0 ? uuid : `conversation-${index}`,
    title: index % 3 === 0 ? null : `Arbeitsauftrag ${index + 1}`,
    status: waiting ? "awaiting_input" : conversation.status,
    last_message_excerpt:
      index % 4 === 0
        ? `{"tool":"run_workflow","output":{"execution_id":"${uuid}"}}`
        : "Eine lange, aber verständliche Zusammenfassung des letzten Arbeitsschritts.",
    ...(index % 6 === 1
      ? {
          target_workflow_id: uuid,
          target_workflow: { id: uuid, slug: "monatsreport", name: "Monatsreport" },
        }
      : {}),
    outcome: waiting
      ? "awaiting_you"
      : index % 5 === 0
        ? "in_progress"
        : index % 7 === 0
          ? "stale"
          : "answered",
    last_activity_at: new Date(Date.parse(conversation.updated_at) - index * 60_000).toISOString(),
    owner: { id: uuid, kind: "user", name: "operator@example.com" },
    surface: ["web", "sk_interactive", "mcp", "api"][index % 4],
    ...(waiting
      ? {
          pending_elicitation_expires_at: new Date(
            SWEEP_NOW + (index === 1 ? -3_600_000 : index * 3_600_000 + 1_800_000),
          ).toISOString(),
          pending_elicitation_summary:
            index % 2 === 1
              ? `Der Monatsreport schreibt künftig nach PROD statt in die Ablage. Soll ich die gespeicherte Version dafür ersetzen? Betroffen sind der Schreibschritt und die Zielangabe; alles andere bleibt, wie es ist. Der letzte Lauf ${uuid} hat die neue Zielangabe schon einmal trocken geprüft.`
              : "Soll ich die gespeicherte Version ersetzen?",
          pending_elicitation_tool: index % 2 === 1 ? "ask_user_confirm" : "ask_user_form",
        }
      : {
          pending_elicitation_expires_at: null,
          pending_elicitation_summary: null,
          pending_elicitation_tool: null,
        }),
    updated_at: new Date(Date.parse(conversation.updated_at) - index * 60_000).toISOString(),
  };
});

const baseMessages = [
  {
    id: "message-1",
    role: "user",
    model: null,
    created_at: "2026-08-10T08:00:00.000Z",
    parts: [{ type: "text", text: "Bitte repariere den Monatsreport." }],
  },
  {
    id: "message-2",
    role: "assistant",
    model: "provider/model-v1",
    created_at: "2026-08-10T08:01:00.000Z",
    parts: [
      {
        type: "text",
        text: `${"Ich habe den Workflow geprüft und die fehlerhafte Transformation eingegrenzt. ".repeat(12)} Die Ausführung ${uuid} wird erst nach Ihrer Freigabe erneut gestartet.`,
      },
    ],
  },
  {
    id: "message-3",
    role: "user",
    model: null,
    created_at: "2026-08-10T08:02:00.000Z",
    parts: [
      {
        type: "text",
        text: "Zeige mir zuerst die geplanten Änderungen an @monatsreport und @legacy-crm.",
        references: [
          { type: "workflow", id: uuid, label: "monatsreport" },
          { type: "connector", id: "catalog-record-3", label: "legacy-crm" },
        ],
        unresolved_references: [{ type: "connector", id: "catalog-record-3", label: "legacy-crm" }],
      },
    ],
  },
  {
    id: "message-4",
    role: "assistant",
    model: "provider/model-v1",
    created_at: "2026-08-10T08:03:00.000Z",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "validate_workflow",
        toolCallId: "tool-call-1",
        state: "output-available",
        input: { name: "Monatsreport" },
        output: { status: "valid" },
      },
    ],
  },
  {
    id: "message-3b",
    role: "assistant",
    model: "provider/model-v2",
    created_at: "2026-08-10T08:02:30.000Z",
    parts: [
      {
        type: "text",
        text: `Der Workflow ${uuid} ist gespeichert und läuft.\n\nConnector-ID: \`${uuid}\` (prod)\n\nStart:\n\n\`\`\`json\n{ "source": "saved", "workflow_id": "${uuid}" }\n\`\`\`\n\nEin gelöschtes Objekt bleibt ohne Namen: 7c9e6679-7425-40de-944b-e07fc1f90ae7.`,
      },
    ],
  },
];

const toolTurn = [
  {
    id: "message-5",
    role: "assistant",
    model: "provider/model-v2",
    created_at: "2026-08-10T08:04:00.000Z",
    parts: [
      {
        type: "tool_call",
        call_id: "bg-1",
        tool: "list_workflows",
        input: { limit: 50 },
      },
      {
        type: "tool_result",
        call_id: "bg-1",
        output: { items: [] },
        outcome: "ok",
      },
      { type: "tool_call", call_id: "bg-2", tool: "get_workflow", input: {} },
      {
        type: "tool_result",
        call_id: "bg-2",
        output: { id: "x" },
        outcome: "ok",
      },
      { type: "tool_call", call_id: "bg-3", tool: "get_workflow", input: {} },
      {
        type: "tool_result",
        call_id: "bg-3",
        output: { id: "y" },
        outcome: "ok",
      },
      {
        type: "tool_call",
        call_id: "bg-4",
        tool: "search_knowledge",
        input: { q: "report" },
      },
      {
        type: "tool_result",
        call_id: "bg-4",
        output: { hits: 3 },
        outcome: "ok",
      },
      {
        type: "tool_call",
        call_id: "act-1",
        tool: "wf_monatsreport-konsolidiert",
        input: { environment: "dev" },
      },
      {
        type: "tool_result",
        call_id: "act-1",
        output: { rows: 42 },
        outcome: "ok",
        confirmation_state: "confirmed",
      },
      {
        type: "tool_call",
        call_id: "act-2",
        tool: "approve_patch_candidate",
        input: { candidate_id: uuid },
      },
      {
        type: "tool_result",
        call_id: "act-2",
        output: { ok: false, error_code: "conflict" },
        outcome: "error",
        confirmation_state: "declined",
      },
      {
        type: "tool_call",
        call_id: "act-3",
        tool: "create_schedule",
        input: { cron: "0 6 * * *" },
      },
    ],
  },
];

const messages = [
  ...baseMessages,
  ...Array.from({ length: 36 }, (_, index) => ({
    id: `history-message-${index}`,
    role: index % 3 === 0 ? "user" : "assistant",
    model: index % 3 === 0 ? null : "provider/model-v1",
    created_at: new Date(Date.parse("2026-08-10T08:04:00.000Z") + index * 60_000).toISOString(),
    parts: [
      {
        type: "text",
        text:
          index % 3 === 0
            ? `Prüfschritt ${index + 1}: Bitte den beobachteten Wert verifizieren.`
            : `${"Der Prüfschritt wurde nachvollziehbar ausgewertet. ".repeat(8)}Lange Werte wie ${"products[0].revenue.last30Days.observedAt".repeat(4)} müssen umbrechen.`,
      },
    ],
  })),
  ...toolTurn,
];

const REAL_OAUTH_CLIENTS = ["Claude", "ChatGPT", "Monitoring"];
const OAUTH_CLIENTS = (() => {
  const at = (day) => `2026-08-${String(day).padStart(2, "0")}T09:00:00.000Z`;
  const dead = Array.from({ length: 200 }, (_, index) => ({
    id: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
    client_id: `deploy-verify-${index}`,
    client_name: "Deploy verify",
    redirect_uris: ["https://verify.example.com/callback"],
    registration_source: "dcr",
    approved_by: [],
    live_connections: 0,
    connected_by: { grants: [], has_unknown_legacy: false },
    disabled_at: null,
    retired_at: null,
    created_at: at(1 + (index % 20)),
  }));
  const retired = Array.from({ length: 30 }, (_, index) => ({
    ...dead[index],
    id: `00000000-0000-4000-9100-${String(index).padStart(12, "0")}`,
    client_id: `deploy-verify-retired-${index}`,
    disabled_at: "2026-08-25T09:00:00.000Z",
    retired_at: "2026-08-25T09:00:00.000Z",
  }));
  const real = REAL_OAUTH_CLIENTS.map((name, index) => ({
    id: `00000000-0000-4000-9200-${String(index).padStart(12, "0")}`,
    client_id: `real-${index}`,
    client_name: name,
    redirect_uris: ["https://app.example.com/callback"],
    registration_source: "dcr",
    approved_by: ["operator@example.com"],
    live_connections: 1,
    last_used_at: index === 2 ? "2026-08-04T08:30:00.000Z" : null,
    connected_by: {
      grants: [
        {
          user_id: `018f4b4a-6d33-7b3a-9c2d-00000000a00${index}`,
          display_name: `Evidence Approver ${index + 1}`,
          email: `approver-${index + 1}@example.test`,
          connected_at: `2026-08-${String(2 + index).padStart(2, "0")}T08:30:00.000Z`,
          revoked_at: null,
        },
      ],
      has_unknown_legacy: index === 2,
    },
    disabled_at: null,
    retired_at: null,
    created_at: at(2 + index),
  }));
  const revoked = {
    ...real[0],
    id: "00000000-0000-4000-9300-000000000000",
    client_id: "revoked",
    client_name: "Altes Werkzeug",
    approved_by: [],
    live_connections: 0,
    disabled_at: "2026-07-01T09:00:00.000Z",
  };
  return [
    ...dead.slice(0, 90),
    real[0],
    ...retired.slice(0, 15),
    revoked,
    ...dead.slice(90, 160),
    real[1],
    ...retired.slice(15),
    ...dead.slice(160),
    real[2],
  ];
})();

const ENGINE_SETTINGS = listConfigLeaves().map((leaf) => {
  const sensitive = Boolean(leaf.meta?.secret);
  const schemaMeta = leafSchemaMeta(leaf);
  const placeholder =
    leaf.kind === "boolean"
      ? false
      : leaf.kind === "number"
        ? 0
        : leaf.kind === "enum"
          ? (leaf.enumValues?.[0] ?? "")
          : leaf.kind === "string-list"
            ? []
            : leaf.kind === "json"
              ? {}
              : "";
  const value = sensitive
    ? null
    : Object.hasOwn(schemaMeta, "default")
      ? schemaMeta.default
      : placeholder;
  return {
    path: leaf.path.join("."),
    value,
    meta: {
      source: "default",
      scope: leaf.meta?.scope ?? "global",
      sensitive,
      requiresRestart: Boolean(leaf.meta?.requiresRestart),
      ...(leaf.description ? { description: leaf.description } : {}),
      kind: leaf.kind,
      ...schemaMeta,
    },
  };
});
const SETTINGS_SECTION_COUNT = new Set(ENGINE_SETTINGS.map((item) => item.path.split(".")[0])).size;

function settingsWith(overrides) {
  const byPath = new Map(overrides.map((item) => [item.path, item]));
  const unknown = overrides.filter(
    (item) => !ENGINE_SETTINGS.some((setting) => setting.path === item.path),
  );
  if (unknown.length)
    throw new Error(
      `settings fixture names settings the engine does not have: ${unknown.map((item) => item.path)}`,
    );
  return ENGINE_SETTINGS.map((item) => {
    const override = byPath.get(item.path);
    if (!override) return item;
    const { default: defaultValue, enum_values } = item.meta;
    return {
      ...override,
      meta: {
        ...(Object.hasOwn(item.meta, "default") ? { default: defaultValue } : {}),
        ...(enum_values ? { enum_values } : {}),
        ...override.meta,
      },
    };
  });
}

const CONNECTIONS = [
  {
    id: "connection-valid",
    name: "Reporting-Portal",
    base_url: "https://reporting.example.com",
    issuer: "https://login.example.com",
    service_name: "Reporting",
    service_description: "Monatszahlen und Auswertungen",
    scopes: ["reports.read"],
    granted_scopes: ["reports.read"],
    state: "valid",
    auto_renew: true,
    expires_at: "2026-12-01T09:00:00.000Z",
    last_used_at: conversation.updated_at,
    last_refreshed_at: conversation.updated_at,
    refresh_failed_at: null,
    last_error: null,
    state_reason: null,
    used_by: [
      {
        connector_id: uuid,
        slug: "reporting-api",
        display_name: "Reporting API",
        workflow_count: 4,
      },
    ],
    created_at: "2026-06-02T09:00:00.000Z",
  },
  {
    id: "connection-expiring",
    name: "Abrechnung",
    base_url: "https://billing.example.com",
    issuer: "https://login.example.com",
    service_name: "Abrechnung",
    service_description: null,
    scopes: ["invoices.read", "invoices.write"],
    granted_scopes: ["invoices.read"],
    state: "expiring",
    auto_renew: true,
    expires_at: "2026-09-05T09:00:00.000Z",
    last_used_at: null,
    last_refreshed_at: null,
    refresh_failed_at: null,
    last_error: null,
    state_reason: null,
    used_by: [],
    created_at: "2026-07-14T09:00:00.000Z",
  },
  {
    id: "connection-expired",
    name: "Postfach",
    base_url: "https://mail.example.com",
    issuer: "https://login.example.com",
    service_name: null,
    service_description: null,
    scopes: ["mail.send"],
    granted_scopes: null,
    state: "expired",
    auto_renew: false,
    expires_at: "2026-08-20T09:00:00.000Z",
    last_used_at: "2026-08-19T09:00:00.000Z",
    last_refreshed_at: null,
    refresh_failed_at: "2026-08-20T09:05:00.000Z",
    last_error: "token endpoint refused: invalid_grant",
    state_reason: "refresh_refused",
    used_by: [],
    created_at: "2026-05-05T09:00:00.000Z",
  },
  {
    id: "connection-unreadable",
    name: "Lager",
    base_url: "https://inventory.example.com",
    issuer: "https://login.example.com",
    service_name: "Lager",
    service_description: null,
    scopes: ["stock.read"],
    granted_scopes: null,
    state: "unreadable",
    auto_renew: false,
    expires_at: null,
    last_used_at: null,
    last_refreshed_at: null,
    refresh_failed_at: null,
    last_error: null,
    state_reason: "secret_unreadable",
    used_by: [],
    created_at: "2026-04-01T09:00:00.000Z",
  },
];

const API_KEY_BASE = {
  scopes: ["workflow:read", "workflow:run"],
  created_at: "2026-08-10T07:00:00.000Z",
  last_used_at: null,
  expires_at: null,
  rotating_out_at: null,
  revoked_at: null,
};
const ACTIVE_KEY_NAMES = [
  "Cockpit verification",
  "Reporting-Export",
  "Nachtlauf",
  "Buchhaltung",
  "Monitoring",
];
const API_KEYS = [
  ...Array.from({ length: 20 }, (_, index) => ({
    ...API_KEY_BASE,
    id: `00000000-0000-4000-9400-${String(index).padStart(12, "0")}`,
    name: `Altes Skript ${index + 1}`,
    prefix: `wf_live_old${index}`,
    revoked_at: "2026-07-20T09:00:00.000Z",
  })),
  ...ACTIVE_KEY_NAMES.map((name, index) => ({
    ...API_KEY_BASE,
    id: index === 0 ? uuid : `00000000-0000-4000-9500-${String(index).padStart(12, "0")}`,
    name,
    prefix: index === 0 ? "wf_live_demo" : `wf_live_key${index}`,
    ...(index === 0
      ? {
          user_id: uuid,
          system_account_id: null,
          creator: { kind: "user", id: REVIEWER_ID },
        }
      : {}),
  })),
  ...Array.from({ length: 20 }, (_, index) => ({
    ...API_KEY_BASE,
    id: `00000000-0000-4000-9600-${String(index).padStart(12, "0")}`,
    name: `Abgelöster Schlüssel ${index + 1}`,
    prefix: `wf_live_gone${index}`,
    revoked_at: "2026-08-01T09:00:00.000Z",
  })),
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

const ATTENTION_ENGINE_DETAIL = "upstream answered 504 after 30s";
const attentionEntry = (entry) => ({
  severity: "urgent",
  cause_class: null,
  counts: {},
  deadline: null,
  detail: null,
  ...entry,
});
const ATTENTION_ITEMS = [
  attentionEntry({
    id: `conversation:${conversation.id}`,
    class: "stopped",
    kind: "conversation",
    subject: { kind: "conversation", id: conversation.id, name: conversation.title },
    reason: "awaiting_answer",
    since: new Date(SWEEP_NOW - 2 * 3_600_000).toISOString(),
    deadline: new Date(SWEEP_NOW + 20 * 3_600_000).toISOString(),
    actions: [
      {
        verb: "answer",
        href: `/cockpit/chat/${conversation.id}`,
        primary: true,
        permission: "conversation:write",
      },
    ],
  }),
  attentionEntry({
    id: "freshness:self_healing.drift_scan",
    class: "stopped",
    severity: "critical",
    kind: "self_healing.drift_scan",
    subject: null,
    reason: "scheduler_stale",
    since: new Date(SWEEP_NOW - 5 * 3_600_000).toISOString(),
    actions: [
      {
        verb: "open",
        href: "/cockpit/audit?scope=operations",
        primary: true,
        permission: "audit:read",
      },
    ],
  }),
  attentionEntry({
    id: `workflow:${uuid}`,
    class: "stopped",
    severity: "critical",
    kind: "workflow",
    subject: { kind: "workflow", id: uuid, name: "Monatsreport" },
    reason: "execution_authority_required",
    counts: { patches: 1 },
    since: new Date(SWEEP_NOW - 36 * 3_600_000).toISOString(),
    detail: ATTENTION_ENGINE_DETAIL,
    actions: [
      {
        verb: "review",
        href: `/cockpit?review=workflow:${uuid}`,
        primary: true,
        permission: "workflow:write",
      },
    ],
  }),
  attentionEntry({
    id: `workflow:${runWorkflowId}`,
    class: "failing",
    kind: "workflow",
    subject: { kind: "workflow", id: runWorkflowId, name: "Umsatzbericht an den Vorstand" },
    reason: "failing",
    cause_class: "timeout",
    counts: { failures: 14 },
    since: new Date(SWEEP_NOW - 3 * 86_400_000).toISOString(),
    detail: ATTENTION_ENGINE_DETAIL,
    actions: [
      {
        verb: "chat",
        href: `/cockpit/chat/new?workflow_id=${runWorkflowId}&execution_id=${uuid}`,
        primary: true,
        permission: "conversation:write",
      },
      {
        verb: "open_runs",
        href: `/cockpit?runs=all&runs_workflow=${runWorkflowId}&runs_status=failed`,
        primary: false,
        permission: "execution:read",
      },
    ],
  }),
  attentionEntry({
    id: `connector:${runConnectorId}`,
    class: "failing",
    kind: "connector",
    subject: { kind: "connector", id: runConnectorId, name: "Mailer" },
    reason: "needs_reauth",
    since: new Date(SWEEP_NOW - 86_400_000).toISOString(),
    detail: "Token refresh rejected by the provider.",
    actions: [
      {
        verb: "reauth",
        href: `/cockpit/connectors/${runConnectorId}`,
        primary: true,
        permission: "connector:oauth",
      },
    ],
  }),
  attentionEntry({
    id: "connection:google-drive",
    class: "failing",
    kind: "connection",
    subject: { kind: "connection", id: "google-drive", name: "Google Drive" },
    reason: "expired_no_refresh",
    since: new Date(SWEEP_NOW - 9 * 86_400_000).toISOString(),
    actions: [
      {
        verb: "renew",
        href: "/cockpit/connectors",
        primary: true,
        permission: "connection:write",
      },
    ],
  }),
  attentionEntry({
    id: "budget",
    class: "failing",
    severity: "critical",
    kind: "token_budget",
    subject: null,
    reason: "budget_critical",
    since: null,
    actions: [{ verb: "open", href: "/cockpit/usage", primary: true, permission: "stats:read" }],
  }),
  attentionEntry({
    id: "secret-approval:smtp_password@3",
    class: "decide",
    kind: "secret_version",
    subject: { kind: "secret", id: "smtp_password@3", name: "smtp_password" },
    reason: "secret_prepared",
    since: new Date(SWEEP_NOW - 4 * 3_600_000).toISOString(),
    actions: [
      { verb: "open", href: "/cockpit/settings", primary: true, permission: "settings:write" },
    ],
  }),
  attentionEntry({
    id: `workflow:${BLOCKED_WORKFLOW_ID}`,
    class: "decide",
    kind: "workflow",
    subject: {
      kind: "workflow",
      id: BLOCKED_WORKFLOW_ID,
      name: "Kontaktformular-Benachrichtigung",
    },
    reason: "version_needs_repair",
    trigger: { kind: "inbound_hook", name: "contact-form" },
    approval: { version: 9, environment: "prod" },
    repair: {
      step_id: "send_notification_email_to_the_operations_mailbox",
      code: "report_delivery_unprepared",
      remedy_kind: "prepare",
      steps: 3,
      candidate_id: null,
      execution_id: null,
    },
    since: new Date(SWEEP_NOW - 60 * 86_400_000).toISOString(),
    actions: [
      {
        verb: "open",
        href: `/cockpit/workflows/${BLOCKED_WORKFLOW_ID}#workflow-automation`,
        primary: true,
        permission: "workflow:run",
      },
    ],
  }),
  attentionEntry({
    id: "skills",
    class: "decide",
    kind: "skill_candidates",
    subject: null,
    reason: "skills_proposed",
    counts: { skills: 1 },
    since: new Date(SWEEP_NOW - 20 * 3_600_000).toISOString(),
    actions: [
      { verb: "review", href: "/cockpit?review=skills", primary: true, permission: "skill:write" },
    ],
  }),
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
function attentionAnswer({ items = ATTENTION_ITEMS, failed = ["risk"] } = {}) {
  return {
    schema_version: "attention.v1",
    generated_at: new Date(SWEEP_NOW).toISOString(),
    sources: Object.fromEntries(
      ATTENTION_SOURCES.map((source) => [source, failed.includes(source) ? "failed" : "answered"]),
    ),
    status: {
      health_state: items.length ? "critical" : "healthy",
      next_run_at: new Date(SWEEP_NOW + 3_600_000).toISOString(),
    },
    items,
  };
}

function sse(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `event: outcome\ndata: ${JSON.stringify(body)}\n\n`,
  });
}

function workflowInvocation(workflowId) {
  const publicUrl = "https://engine.example.test";
  const sample = { month: "<month>" };
  const body = { source: "saved", workflow_id: workflowId, input: sample };
  const call = (environment, language) =>
    language === "curl"
      ? [
          `curl -sS -X POST '${publicUrl}/v1/executions' \\`,
          `  -H 'authorization: Bearer '"$SK_API_KEY" \\`,
          `  -H 'x-subkit-environment: ${environment}' \\`,
          `  -H 'content-type: application/json' \\`,
          `  -d '${JSON.stringify(body)}'`,
        ].join("\n")
      : `# ${language}, ${environment}\n${JSON.stringify(body)}`;
  return {
    workflow_id: workflowId,
    slug: "monatsreport",
    base_url: publicUrl,
    http: {
      method: "POST",
      path: "/v1/executions",
      url: `${publicUrl}/v1/executions`,
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
      tool_name: "wf_monatsreport",
      fallback: {
        tool_name: "run_workflow",
        arguments: { workflow: "monatsreport", input: sample },
      },
    },
    schedules: [],
    cli: {
      command: `sk workflows run monatsreport --input '${JSON.stringify(sample)}'`,
      environment: "dev",
    },
    input: {
      source: "synthesized",
      schema: {
        type: "object",
        properties: {
          month: {
            type: "string",
            description:
              "Abrechnungsmonat im Format JJJJ-MM, für den der Report aller Tochtergesellschaften erzeugt wird",
          },
          include_adjustments_and_consolidation_entries: { type: "boolean" },
        },
      },
      sample,
    },
    output: { schema: null },
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
}

const CATALOG_META = [
  {
    description:
      "Sammelt jeden Monat die Zahlen aller Tochtergesellschaften, gleicht Nachbuchungen ab, konsolidiert Währungen und verschickt den Bericht an Finanzen, Controlling und die Geschäftsführung — inklusive Anhang mit allen Einzelposten und einer Abweichungsanalyse gegenüber dem Vormonat.",
    description_source: "human",
    category: "reporting",
    category_source: "human",
  },
  {
    description: "Liest neue Belege und legt sie im Archiv ab.",
    description_source: "llm",
    category: "betrieb",
    category_source: "llm",
  },
  { description: null, description_source: "llm", category: "other", category_source: "llm" },
  {
    description: "Prüft Monatsabschlüsse vor dem Versand.",
    description_source: "human",
    category: "reporting",
    category_source: "human",
  },
];

async function mockApi(route, options = {}) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path === "/v1/cockpit/bootstrap") {
    return json(route, {
      principal: {
        id: uuid,
        kind: "user",
        email: "operator@example.com",
        role_name: "admin",
        provider: "browser_session",
      },
      tenant: { id: uuid, slug: "default", display_name: "Default Tenant" },
      session: {
        expires_at: "2026-08-11T09:00:00.000Z",
        absolute_expires_at: null,
      },
      permissions: options.permissions ?? [
        "conversation:read",
        "conversation:write",
        "conversation:approve",
        "workflow:read",
        "workflow:write",
        "workflow:run",
        "schedule:read",
        "execution:read",
        "connector:read",
        "connector:write",
        "connector:test",
        "connection:read",
        "connection:write",
        "knowledge:read",
        "knowledge:write",
        "skill:read",
        "skill:write",
        "skill:activate",
        "file:read",
        "file:write",
        "notification:read",
        "notification:write",
        "audit:read",
        "stats:read",
        "stats:read:all",
        "identity:read",
        "rbac:read",
        "api_key:read",
        "mcp_oauth_client:read",
        "mcp_oauth_client:revoke",
        "settings:read",
        "identity:write",
        "rbac:write",
        "api_key:write",
        "api_key:rotate",
        "api_key:revoke",
        "settings:write",
        "self_healing:read",
        "self_healing:write",
      ],
      csrf_token: "test-csrf",
      version: "visual-sweep",
      oauth_callback_url: `${url.origin}/v1/oauth/callback`,
      recent_conversations: [],
    });
  }
  if (/^\/v1\/workflows\/[^/]+\/automation-status$/.test(path))
    return json(route, { schedules: [], inbound_hooks: [] });
  const diagnosed = /^\/v1\/workflows\/([^/]+)\/diagnosis$/.exec(path);
  if (diagnosed)
    return json(route, {
      workflow_id: diagnosed[1],
      workflow_version_id: null,
      environment: url.searchParams.get("environment") ?? "prod",
      is_current: false,
      diagnoses: [],
    });
  const invoked = /^\/v1\/workflows\/([^/]+)\/invocation$/.exec(path);
  if (invoked) return json(route, workflowInvocation(invoked[1]));
  if (path === "/v1/schedules") return json(route, { schedules: [], total: 0 });
  if (path === "/v1/attention") return json(route, attentionAnswer());
  if (path === "/v1/conversations" && request.method() === "GET") {
    const search = new URL(request.url()).searchParams;
    const status = search.get("status");
    if (search.get("hidden") === "only") return json(route, { items: [], total: 0 });
    const items = status ? conversations.filter((entry) => entry.status === status) : conversations;
    return json(route, { items, total: items.length });
  }
  if (path === "/v1/conversations" && request.method() === "POST")
    return sse(route, { conversation, status: "active" });
  if (path === `/v1/conversations/${uuid}/hide` || path === `/v1/conversations/${uuid}/unhide`)
    return json(route, conversation);
  if (path === `/v1/conversations/${uuid}`) {
    return json(route, {
      conversation: { ...conversation, surface: "web" },
      owner: { id: uuid, kind: "user", name: "operator@example.com" },
      created_resources: [
        {
          kind: "execution",
          id: uuid,
          slug: "monatsreport",
          name: null,
          at: conversation.updated_at,
        },
        {
          kind: "workflow",
          id: uuid,
          slug: "monatsreport",
          name: "Monatsreport",
          at: new Date(Date.parse(conversation.updated_at) - 3_600_000).toISOString(),
        },
      ],
      messages,
      tool_calls: [],
      draft: { session: { permission_mode: "auto" } },
      resume_summary: {
        active_target: {
          kind: "none",
          name: "none",
          slug: null,
          id: null,
          environment: null,
        },
        stage: "onboarding",
        last_successful_probe: null,
        last_successful_preview: null,
        unsaved: false,
        pending_approval: null,
        next_action: "Continue the conversation.",
        one_sentence: "You have an in-progress conversation. Continue the conversation.",
      },
      usage: {
        tokens: 48_210,
        by_model: [
          { model: "provider/model-v1", tokens: 40_000 },
          { model: "provider/unpriced-v0", tokens: 8_210 },
        ],
        cost: { amount: 0.1834, currency: "USD", unpriced_models: ["provider/unpriced-v0"] },
      },
    });
  }
  if (path === `/v1/conversations/${uuid}/messages`)
    return sse(route, { conversation, status: "active" });
  if (path === `/v1/workflows/${uuid}/execution-authorities`) {
    const now = Date.now();
    return json(route, {
      items: [
        {
          id: hostileAuthority.id,
          workflow_id: uuid,
          workflow_version_id: hostileAuthority.workflow_version_id,
          effect_manifest_digest: "7".repeat(64),
          execution_environment: "prod",
          valid_from: new Date(now - 3_600_000).toISOString(),
          valid_until: new Date(now + 5 * 86_400_000).toISOString(),
          max_runs: 24,
          reserved_runs: 3,
          remaining_runs: 21,
          active_version: false,
          ready_for_new_run: false,
          state: "approved",
          created_at: new Date(now - 3_600_000).toISOString(),
          created_by: hostileAuthority.created_by,
          revoked_at: null,
          revoked_by: null,
          open_ended: false,
          inherited_from: null,
          superseded_by: null,
          target_constraints: { targets: ["https://reports.example.test/monthly"] },
          effect_manifest: {
            schema_version: 1,
            tenant_id: hostileAuthority.tenant_id,
            workflow_id: uuid,
            workflow_version_id: hostileAuthority.workflow_version_id,
            workflow_digest: "8".repeat(64),
            execution_environment: "prod",
            execution_options_digest: "9".repeat(64),
            effects: [
              {
                tenant_id: hostileAuthority.tenant_id,
                step_id: "publish-report",
                connector_id: hostileAuthority.connector_id,
                driver: "http",
                environment: "prod",
                request_digest: "1".repeat(64),
                configuration_digest: "2".repeat(64),
                credential_binding_digest: "3".repeat(64),
                target: "https://reports.example.test/monthly",
                rewrites_target: false,
                operation: "POST",
                effect: "write",
              },
            ],
            issues: [],
          },
        },
      ],
      next_cursor: null,
    });
  }
  if (path === "/v1/workflows/catalog-record-1")
    return json(route, {
      id: "catalog-record-1",
      name: "Monatsreport für alle Tochtergesellschaften",
    });
  if (path === "/v1/workflows/0e6b2c52-7d1f-4d8e-9d55-5f0c2f7a9e10")
    return json(route, { error: { code: "not_found", message: "workflow" } }, 404);

  if (path === `/v1/workflows/${uuid}`)
    return json(route, {
      ...CATALOG_META[0],
      id: uuid,
      name: "Monatsreport",
      slug: "monatsreport",
      lifecycle: "active",
      current_version: 8,
      current_version_id: "018f4b4a-6d33-7b3a-9c2d-123456789ab8",
      created_at: "2026-06-01T08:00:00.000Z",
      last_executed_at: "2026-08-10T07:00:00.000Z",
      input_schema: null,
      output_schema: null,
      trigger: null,
      schedule: null,
      webhooks_active: 0,
      effective_trigger: { kind: "request", source: "default", state: "active" },
      steps: [
        {
          id: "fetch",
          name: "Daten laden",
          kind: "request",
          method: "GET",
          path: `/v1/reports/${runConnectorId}/rows`,
          connector_id: uuid,
          query: { month: "2026-07" },
        },
        {
          id: "check",
          kind: "branch",
          when: "fetch.status = 200",
          then_steps: ["transform"],
          else_steps: [],
        },
        {
          id: "transform",
          name: "Report berechnen",
          kind: "transform",
          expression: "return { rows: input.scope.fetch.data.length };",
        },
      ],
      health_state: "degraded",
      health_reason: "3 consecutive scheduled runs failed",
      health_changed_at: "2026-08-10T08:00:00.000Z",
      updated_at: "2026-08-10T09:00:00.000Z",
    });
  if (path === `/v1/connectors/${runConnectorId}`)
    return json(route, {
      id: runConnectorId,
      display_name: "Berichtsablage",
      slug: "berichtsablage",
      driver: "http",
      environment: "prod",
      enabled: true,
      auth_type: "oauth2",
      sign_in: { kind: "oauth", start: `/v1/connectors/${runConnectorId}/oauth/start` },
      health_state: "needs_reauth",
      needs_reauth: true,
      updated_at: "2026-08-10T09:00:00.000Z",
    });
  if (path === `/v1/connectors/${uuid}`)
    return json(route, {
      ...CATALOG_META[1],
      id: uuid,
      display_name: "Reporting API",
      slug: "reporting-api",
      driver: "http",
      environment: "prod",
      enabled: true,
      health_state: "ok",
      updated_at: "2026-08-10T09:00:00.000Z",
    });
  if (path === `/v1/knowledge-sources/${uuid}`)
    return json(route, {
      id: uuid,
      tenant_id: uuid,
      name: "Betriebshandbuch",
      slug: "betriebshandbuch",
      ...CATALOG_META[2],
      tags: [],
      scope: "global",
      workflow_id: null,
      status: "active",
      last_error: null,
      source_type: "url",
      source_uri: "https://docs.example.com/betrieb",
      mime_type: "text/markdown",
      version: "knowledge-v4",
      bytes_total: 18400,
      chunk_count: 3,
      refresh_strategy: "manual",
      refresh_cron: null,
      last_refreshed_at: "2026-08-10T09:00:00.000Z",
      created_at: "2026-07-01T09:00:00.000Z",
      updated_at: "2026-08-10T09:00:00.000Z",
    });
  if (path === `/v1/knowledge-sources/${uuid}/chunks`)
    return json(route, {
      knowledge_source_id: uuid,
      name: "Betriebshandbuch",
      chunk_count: 3,
      items: [
        ["/betrieb/einleitung", "Einleitung", "# Einleitung\n\nWie wir den Betrieb führen."],
        [
          "/betrieb/pruefungen",
          "Prüfungen",
          "| Prüfung | Intervall |\n|---|---|\n| Konnektor-Zustand | täglich |",
        ],
        [
          "/betrieb/eskalation",
          "Eskalation",
          "1. Bereitschaft anrufen\n2. Ursache im Audit prüfen",
        ],
      ].map(([chunkPath, title, content], ordinal) => ({
        ordinal,
        title,
        path: chunkPath,
        content,
        byte_size: content.length,
      })),
    });
  if (path === `/v1/knowledge-sources/${uuid}/content`)
    return json(route, {
      knowledge_source_id: uuid,
      version: "knowledge-v4",
      editable: true,
      documents: [
        {
          path: "betrieb.md",
          content:
            "# Betriebshandbuch\n\n| Prüfung | Intervall | Verantwortlich |\n|---|---:|---|\n| Connector-Zustand | täglich | Betrieb |",
        },
      ],
    });
  if (path === `/v1/skills/${uuid}`)
    return json(route, {
      ...CATALOG_META[3],
      id: uuid,
      title: "Sichere Reports",
      slug: "sichere-reports",
      body: "# Sichere Reports\n\nVor externen Schreibzugriffen immer eine Freigabe einholen.",
      scope: "global",
      applies_to: "chat",
      status: "active",
      source: "manual",
      maturity: "stable",
      version: 3,
      created_at: "2026-07-01T09:00:00.000Z",
      updated_at: "2026-08-10T09:00:00.000Z",
    });
  if (path === `/v1/files/${uuid}`)
    return json(route, {
      ...CATALOG_META[0],
      id: uuid,
      filename: "report-notes.md",
      slug: "report-notes",
      reference: "@attachment:report-notes",
      status: "ready",
      content_type: "text/markdown",
      size_bytes: 1840,
      created_at: "2026-08-10T09:00:00.000Z",
    });
  if (path === `/v1/files/${uuid}/usage`)
    return json(route, {
      workflows: [{ id: uuid, name: "Monatsreport" }],
      conversations: [{ id: uuid, title: "Monatsreport reparieren" }],
      other: 1,
    });
  if (path === `/v1/files/${uuid}/content`)
    return route.fulfill({
      status: 200,
      contentType: "text/markdown",
      body: "# Report notes\n\nValidated input.",
    });
  if (path === "/v1/categories")
    return json(route, {
      categories: [
        {
          category: "reporting",
          total: 44,
          counts: { workflow: 21, connector: 11, knowledge_source: 6, skill: 3, file: 3 },
        },
        {
          category: "betrieb",
          total: 30,
          counts: { workflow: 10, connector: 10, knowledge_source: 5, skill: 3, file: 2 },
        },
        {
          category: "other",
          total: 40,
          counts: { workflow: 11, connector: 10, knowledge_source: 10, skill: 5, file: 4 },
        },
      ],
    });
  if (
    [
      "/v1/workflows",
      "/v1/connectors",
      "/v1/knowledge-sources",
      "/v1/skills",
      "/v1/files",
    ].includes(path)
  ) {
    const rowFor = (index) => ({ ...CATALOG_META[index % 4], ...catalogRowFor(index) });
    const catalogRowFor = (index) => {
      const rotate = index % 4;
      if (path === "/v1/workflows")
        return {
          slug: `reporting-monatsreport-${index}`,
          name:
            index === 1
              ? "Monatsreport für alle Tochtergesellschaften inklusive Nachbuchungen und Konsolidierung"
              : `Monatsreport ${index + 1}`,
          lifecycle: ["active", "draft", "archived", "active"][rotate],
          current_version: 8,
          connectors: rotate === 2 ? [] : ["reporting-api", "mailer"].slice(0, rotate + 1),
          trigger:
            rotate === 1
              ? { kind: "schedule", cron: "0 6 * * *", tz: "UTC" }
              : rotate === 3
                ? {
                    kind: "webhook",
                    source: "stripe",
                    events: [],
                    verify: "none",
                  }
                : null,
          effective_trigger: {
            kind: rotate === 1 ? "schedule" : rotate === 3 ? "webhook" : "request",
            source: rotate === 1 || rotate === 3 ? "definition" : "default",
            state: "active",
          },
          health_state: rotate === 3 ? "degraded" : rotate === 1 ? "needs_attention" : "ok",
          health_reason: rotate === 3 ? "Drei Läufe in Folge fehlgeschlagen." : null,
          last_executed_at: rotate === 2 ? null : conversation.updated_at,
          updated_at: conversation.updated_at,
        };
      if (path === "/v1/connectors")
        return {
          slug: ["reporting-api", "mailer", "warehouse", "legacy-crm"][rotate],
          display_name: ["Reporting API", "Mailer", "Warehouse", "Legacy CRM"][rotate],
          driver: ["http", "graphql", "postgres", "s3"][rotate],
          environment: index % 2 === 0 ? "prod" : "dev",
          auth_type: rotate === 2 ? "none" : "oauth2",
          health_state: ["ok", "needs_reauth", "ok", "degraded"][rotate],
          health_reason: rotate === 3 ? "Endpunkt antwortet mit 502." : null,
          needs_reauth: rotate === 1,
          auth_failed_at: rotate === 1 ? conversation.updated_at : null,
          enabled: rotate !== 2,
          updated_at: conversation.updated_at,
        };
      if (path === "/v1/knowledge-sources")
        return {
          name: `Betriebshandbuch ${index + 1}`,
          slug: `betriebshandbuch-${index + 1}`,
          status: ["active", "processing", "error", "inactive"][rotate],
          scope: rotate === 1 ? "workflow" : "global",
          workflow_id: rotate === 1 ? uuid : null,
          source_type: "file_upload",
          chunk_count: 12,
          bytes_total: rotate === 2 ? null : 18400,
          updated_at: conversation.updated_at,
        };
      if (path === "/v1/skills")
        return {
          title: `Sichere Reports ${index + 1}`,
          slug: rotate === 3 ? null : `sichere-reports-${index + 1}`,
          status: ["active", "draft", "archived", "active"][rotate],
          scope: ["global", "connector", "workflow", "global"][rotate],
          connector_id: rotate === 1 ? uuid : null,
          workflow_id: rotate === 2 ? uuid : null,
          side_effects: ["read", "write", "destructive", "none"][rotate],
          applies_to: ["both", "chat", "authoring", "both"][rotate],
          maturity: rotate === 1 ? "experimental" : "stable",
          version: 3,
          updated_at: conversation.updated_at,
        };
      return {
        filename: `report-notes-${index + 1}.md`,
        slug: `report-notes-${index + 1}`,
        reference: `@attachment:report-notes-${index + 1}`,
        usage: {
          workflows: [2, 1, 0, 0][rotate],
          conversations: [1, 1, 3, 0][rotate],
        },
        status: ["ready", "scanning", "failed", "expired"][rotate],
        scan_result: ["clean", "noop", "infected", "timeout"][rotate],
        content_type: "text/markdown",
        size_bytes: rotate === 2 ? null : 1840,
        created_at: conversation.updated_at,
      };
    };
    const narrowed = path === "/v1/connectors" && url.searchParams.get("health") === "not_ok";
    const items = Array.from({ length: 42 }, (_, index) => ({
      ...rowFor(index),
      id: index === 0 ? uuid : `catalog-record-${index}`,
    }))
      .filter((row) => !narrowed || (row.enabled === true && row.health_state !== "ok"))
      .filter(
        (row) =>
          path !== "/v1/connectors" ||
          url.searchParams.get("enabled") !== "true" ||
          row.enabled === true,
      );
    const categories =
      path === "/v1/workflows" || path === "/v1/connectors"
        ? [
            { category: "reporting", count: 21 },
            { category: "betrieb", count: 21 },
          ]
        : undefined;
    return json(route, {
      items: pageOf(items, url),
      total: items.length,
      ...(categories ? { categories } : {}),
    });
  }
  if (path === "/v1/connections") {
    return json(route, {
      items: CONNECTIONS,
    });
  }
  if (path === "/v1/executions") {
    const items = Array.from({ length: 24 }, (_, index) => {
      const rotate = index % 4;
      const started = new Date(Date.parse(conversation.updated_at) - index * 300_000);
      return {
        id: index === 0 ? uuid : `execution-${index}`,
        workflow_id: rotate === 2 ? null : uuid,
        workflow_name:
          rotate === 2
            ? null
            : index === 1
              ? "Monatsreport für alle Tochtergesellschaften inklusive Nachbuchungen und Konsolidierung"
              : `Monatsreport ${index + 1}`,
        workflow_version_id: null,
        hold_writes: rotate === 2,
        source_kind: ["saved", "draft", "step", "saved"][rotate],
        source_ref: null,
        status: ["succeeded", "running", "failed", "timed_out"][rotate],
        request_source: ["scheduler", "chat", "api", "carrier-pigeon"][rotate],
        caller:
          rotate === 2
            ? {
                kind: "system_account",
                principal_id: uuid,
                provider: "api_key",
                product_id: null,
                verified_by: "api_key",
                channel: "api",
                origin_execution_id: null,
              }
            : {
                kind: "engine",
                principal_id: null,
                provider: null,
                product_id: null,
                verified_by: null,
                channel: ["scheduler", "chat", "api", "carrier-pigeon"][rotate],
                origin_execution_id: null,
              },
        parent_execution_id: rotate === 2 ? uuid : null,
        started_at: started.toISOString(),
        finished_at: rotate === 1 ? null : new Date(started.getTime() + 119_600).toISOString(),
        created_at: started.toISOString(),
        failure:
          rotate === 2
            ? { step_key: "write_products", cause_class: "auth_failed" }
            : rotate === 3
              ? { step_key: null, cause_class: "timeout" }
              : null,
        error_message: rotate === 2 ? "PRIVATE_FAILURE_SENTINEL_DO_NOT_RENDER" : null,
      };
    });
    const status = url.searchParams.get("status");
    const statuses = status ? status.split(",") : [];
    const limit = Number(url.searchParams.get("limit") ?? "0");
    const narrowed = status ? items.filter((item) => statuses.includes(item.status)) : items;
    return json(route, {
      items: limit > 0 ? narrowed.slice(0, limit) : narrowed,
      total: statuses.length > 1 ? narrowed.length * 10 : status ? narrowed.length : 240,
      next_cursor: null,
    });
  }
  const oneExecution = /^\/v1\/executions\/([^/]+)$/.exec(path);
  if (oneExecution) {
    const started = new Date(Date.parse(conversation.updated_at));
    return json(route, {
      id: decodeURIComponent(oneExecution[1]),
      workflow_id: runWorkflowId,
      workflow_name: "Monatsreport 1",
      workflow_version_id: runVersionId,
      execution_authority_id: null,
      hold_writes: false,
      source_kind: "saved",
      source_ref: null,
      status: "failed",
      request_source: "scheduler",
      caller: {
        kind: "engine",
        principal_id: null,
        provider: null,
        product_id: null,
        verified_by: null,
        channel: "scheduler",
        origin_execution_id: null,
      },
      parent_execution_id: null,
      started_at: started.toISOString(),
      finished_at: new Date(started.getTime() + 6_900).toISOString(),
      created_at: started.toISOString(),
      outcome: {
        kind: "failed",
        failed_step: { step_key: "write_products", kind: "request" },
        cause_class: "auth_failed",
        error_code: "http_401",
        steps: { total: 3, succeeded: 2, failed: 1, held: 0, skipped: 0 },
        output_contract: "none",
      },
    });
  }
  if (/^\/v1\/executions\/[^/]+\/steps$/.test(path)) {
    return json(route, {
      items: [
        {
          step_key: "read_current",
          step_index: 0,
          status: "succeeded",
          duration_ms: 78,
          error: null,
          input_preview: { bucket: "reports" },
          request_meta: {
            connector: { connector_id: runConnectorId, driver: "http" },
            extras: { effect_kind: "read" },
          },
          credential_snapshots: [
            {
              connector_id: runConnectorId,
              environment: "prod",
              credential_generation: 3,
              access_token_version: null,
              identity: {
                issuer: "https://identity.example.test",
                subject: "report-reader-fixture",
                source: "token_endpoint",
              },
            },
          ],
          output_preview: { rows: 412, bytes: 337_858 },
          result_preview: null,
        },
        {
          step_key: "summarise",
          step_index: 1,
          status: "succeeded",
          duration_ms: 4_120,
          error: null,
          output_preview: {},
          result_preview: null,
        },
        {
          step_key: "write_products",
          step_index: 2,
          status: "failed",
          duration_ms: 69,
          request_meta: {
            connector: {
              step_key: "write_products",
              connector_id: runConnectorId,
              connector_slug: "berichtsablage",
              driver: "http",
            },
          },
          error: {
            code: "request_outside_declared_boundary",
            message:
              "This request is outside the folder boundary its step declares: the content is 337858 bytes but `s3.scope.max_bytes` is 131072. Nothing was sent.",
            resolved_url:
              "https://storage.example.com/berichtsablage/reports/2026/products/write_products_full_export_with_a_very_long_object_key_that_never_breaks.json",
          },
          output_preview: null,
          result_preview: "null",
        },
      ],
      next_cursor: null,
    });
  }
  if (path === "/v1/audit-log") {
    const wanted = (url.searchParams.get("action") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const actorType = url.searchParams.get("actor_type");
    const byAction = wanted.length
      ? AUDIT_PAGED_ENTRIES.filter((entry) => wanted.includes(entry.action))
      : AUDIT_PAGED_ENTRIES;
    const matching = actorType
      ? byAction.filter((entry) => entry.actor_type === actorType)
      : byAction;
    const after = url.searchParams.get("cursor");
    const start = after ? matching.findIndex((entry) => entry.id === after) + 1 : 0;
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const items = matching.slice(start, start + limit);
    const more = start + limit < matching.length;
    return json(route, { items, next_cursor: more ? (items.at(-1)?.id ?? null) : null });
  }
  const auditEntryPath = /^\/v1\/audit-log\/([^/]+)$/.exec(path);
  if (auditEntryPath) {
    const id = decodeURIComponent(auditEntryPath[1]);
    const entry = AUDIT_PAGED_ENTRIES.find((candidate) => candidate.id === id);
    return entry
      ? json(route, entry)
      : json(route, { error: { code: "not_found", message: "audit_entry" } }, 404);
  }
  if (path === "/v1/notifications/inbox") {
    const EVENTS = [
      ["execution.failed", true, "execution"],
      ["connector.auth_failed", true, "connector"],
      ["patch.proposed", true, "patch_candidate"],
      ["execution.succeeded", false, "execution"],
      ["workflow.updated", false, "workflow"],
      ["something.unmapped", false, null],
    ];
    const actionableOnly = url.searchParams.get("actionable_only") === "true";
    const unreadOnly = url.searchParams.get("unread_only") === "true";
    return json(route, {
      items: Array.from({ length: 12 }, (_, index) => {
        const [event_type, actionable, resource_type] = EVENTS[index % EVENTS.length];
        const read = index % 3 === 0;
        return {
          id: index + 1,
          severity: ["error", "warn", "info", "critical"][index % 4],
          event_type,
          event_payload: {},
          actionable,
          resource_type,
          resource_id: resource_type ? uuid : null,
          read,
          read_at: read ? conversation.updated_at : null,
          created_at: new Date(Date.parse(conversation.updated_at) - index * 600_000).toISOString(),
        };
      }).filter((item) => (!actionableOnly || item.actionable) && (!unreadOnly || !item.read)),
      cursor: 12,
      unread_count: 8,
      actionable_unread_count: 4,
    });
  }
  if (/^\/v1\/executions\/[^/]+\/cost$/.test(path)) {
    return json(route, {
      llm: {
        calls: 7,
        weighted_tokens: 58_472,
        prompt_tokens: 61_400,
        completion_tokens: 812,
        cache_read_tokens: 38_100,
        cache_read_pct: 62,
        latency_ms: 14_300,
        by_flow: [
          {
            flow: "converse",
            calls: 5,
            weighted_tokens: 51_000,
            prompt_tokens: 54_000,
            completion_tokens: 700,
            cache_read_tokens: 35_000,
            latency_ms: 11_000,
          },
          {
            flow: "judge",
            calls: 2,
            weighted_tokens: 7_472,
            prompt_tokens: 7_400,
            completion_tokens: 112,
            cache_read_tokens: 3_100,
            latency_ms: 3_300,
          },
        ],
      },
      external: { calls: 3, cost_usd: 0.1834, units: 3, latency_ms: 900 },
    });
  }
  if (path === "/v1/status") {
    return json(route, {
      tokens_today: 1_240_000,
      tokens_month: 142_500_000,
      monthly_budget_tokens: 150_000_000,
      remaining_monthly_budget_tokens: 7_500_000,
      monthly_budget_state: "critical",
      llm_provider: { configured: true, reachable: true },
    });
  }
  if (path === "/v1/stats/llm") {
    if (!url.searchParams.get("bucket") || !url.searchParams.get("from"))
      return json(route, { code: "validation", message: "request validation failed" }, 400);
    const axis = url.searchParams.get("group_by") ?? "workflow";
    const byAxis = {
      workflow: [
        [uuid, 812, 96_400_000],
        ["catalog-record-1", 240, 31_600_000],
        ["0e6b2c52-7d1f-4d8e-9d55-5f0c2f7a9e10", 61, 10_000_000],
        ["", 611, 74_000_000],
      ],
      flow: [
        ["converse", 690, 88_000_000],
        ["suggest_next", 40, 2_000_000],
        ["generate", 210, 34_000_000],
        ["summarize", 90, 9_000_000],
        ["judge", 180, 12_000_000],
        ["repair", 33, 4_000_000],
        ["critic_authoring", 12, 1_000_000],
        ["workflow_step", 61, 6_000_000],
        ["extract", 8, 500_000],
        ["some_future_flow", 4, 300_000],
        ["", 2, 200_000],
      ],
      user: [
        ["465c1424-676e-44c4-8ec0-7ff754f167b4", 900, 120_000_000],
        ["b221a085-3c6f-49e1-8553-3298949ab4db", 223, 18_000_000],
      ],
      model: [
        ["claude-sonnet-4-6", 820, 104_000_000, "Claude Sonnet 4.6"],
        ["claude-haiku-4-5-20251001", 303, 34_000_000, "Claude Haiku 4.5"],
        ["my-local-model", 12, 1_000_000],
      ],
    };
    const rows = byAxis[axis] ?? byAxis.workflow;
    return json(route, {
      bucket: "day",
      tz: "UTC",
      from: "2026-07-11T00:00:00.000Z",
      to: "2026-08-10T00:00:00.000Z",
      groups: rows.map(([key, calls, total, modelName]) => ({
        key: { [axis]: key },
        ...(modelName ? { model_name: modelName } : {}),
        buckets: [],
        totals: {
          calls,
          tokens: { prompt: total, completion: 0, cache_read: 0, cache_creation: 0, total },
          latency_ms: { total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
        },
        cost: {
          amount: Math.round(((412.87 * total) / rows.reduce((n, r) => n + r[2], 0)) * 100) / 100,
          currency: "EUR",
          unpriced_calls: 0,
        },
      })),
      totals: {
        calls: { total: rows.reduce((n, r) => n + r[1], 0), by_result: {} },
        tokens: {
          prompt: rows.reduce((n, r) => n + r[2], 0),
          completion: 0,
          cache_read: 0,
          cache_creation: 0,
          total: rows.reduce((n, r) => n + r[2], 0),
        },
        latency_ms: { total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
      },
      cost: {
        amount: 412.87,
        currency: "EUR",
        unpriced_models: ["some-new-model"],
        unpriced_calls: 47,
        price_sources: [
          { model: "claude-sonnet-4-6", price_source: "catalog" },
          { model: "claude-haiku-4-5", price_source: "override" },
        ],
        rates_basis: "current",
      },
    });
  }
  if (path === "/v1/stats/operating-figures") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to)
      return json(route, { code: "validation", message: "request validation failed" }, 400);
    const window = { runs_from: from, runs_to: to };
    return json(route, {
      schema_version: "operating-figures.v1",
      window: { from, to },
      runs: {
        total: 40,
        succeeded: 36,
        failed: 4,
        finished: 40,
        success_rate_percent: 90,
        href: `/cockpit?${new URLSearchParams({ runs: "all", ...window })}`,
        failed_href: `/cockpit?${new URLSearchParams({ runs: "all", runs_status: "failed", ...window })}`,
      },
      connectors: {
        enabled: 32,
        not_ok: 21,
        needs_reauth: 5,
        healthy_percent: 34,
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
    if (url.searchParams.get("group_by") === "workflow_id")
      return json(route, {
        bucket: "day",
        tz: "UTC",
        from: "2026-07-11T00:00:00.000Z",
        to: "2026-08-10T00:00:00.000Z",
        groups: [
          [uuid, 30],
          ["catalog-record-1", 10],
        ].map(([workflow_id, executions]) => ({
          key: { workflow_id },
          buckets: [],
          totals: {
            executions,
            duration_ms: { total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
          },
        })),
        totals: {
          executions: { count: 40, by_status: { completed: 36, failed: 4 } },
          duration_ms: { total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
        },
      });
    return json(route, {
      bucket: "day",
      tz: "UTC",
      from: "2026-07-11T00:00:00.000Z",
      to: "2026-08-10T00:00:00.000Z",
      groups: [
        {
          key: {},
          buckets: [
            {
              ts: "2026-08-09T00:00:00.000Z",
              executions: 18,
              duration_ms: {
                total: 18000,
                avg: 1000,
                p50: 800,
                p95: 2100,
                p99: 2400,
                max: 2600,
              },
            },
            {
              ts: "2026-08-10T00:00:00.000Z",
              executions: 22,
              duration_ms: {
                total: 26400,
                avg: 1200,
                p50: 900,
                p95: 2500,
                p99: 2900,
                max: 3200,
              },
            },
          ],
          totals: {
            executions: 40,
            duration_ms: {
              total: 44400,
              avg: 1110,
              p50: 850,
              p95: 2300,
              p99: 2700,
              max: 3200,
            },
          },
        },
      ],
      totals: {
        executions: { count: 40, by_status: { completed: 36, failed: 4 } },
        duration_ms: {
          total: 44400,
          avg: 1110,
          p50: 850,
          p95: 2300,
          p99: 2700,
          max: 3200,
        },
      },
    });
  }
  if (path === "/v1/operator/health-digest")
    return json(route, {
      generated_at: "2026-08-10T09:00:00.000Z",
      window_hours: 24,
      headline: "Ein geplanter Lauf scheitert wiederholt.",
      failure_groups: [
        {
          signature: "monthly:fetch:http_502",
          workflow_id: uuid,
          workflow_name: "Monatsreport",
          step_key: "fetch",
          error_code: "http_502",
          origin: "scheduled",
          count: 14,
          scheduled_count: 14,
          last_seen: "2026-08-10T08:40:00.000Z",
          cause: "Das angebundene System antwortet seit gestern mit einem Fehler.",
          guidance: "Zugangsdaten prüfen und den Lauf erneut anstoßen.",
          resolved_at: null,
        },
        {
          signature: "monthly:store:storage_refused",
          workflow_id: uuid,
          workflow_name: "Monatsreport",
          step_key: "store",
          error_code: "storage_refused",
          origin: "scheduled",
          count: 3,
          scheduled_count: 3,
          last_seen: "2026-08-09T22:00:00.000Z",
          cause: "Die Ablage hat den Schreibzugriff abgelehnt.",
          guidance: "",
          resolved_at: "2026-08-10T06:00:00.000Z",
        },
        {
          signature: "draft:transform:type_error",
          workflow_id: uuid,
          workflow_name: "Entwurf: Umsatzrollup",
          step_key: "transform",
          error_code: "type_error",
          origin: "authoring",
          count: 23,
          scheduled_count: 0,
          last_seen: "2026-08-10T08:10:00.000Z",
          cause: "Ein Testlauf beim Bauen ist an der Umwandlung gescheitert.",
          guidance: "",
          resolved_at: null,
        },
      ],
      patch_candidates: {
        pending: 3,
        items: [
          {
            id: uuid,
            workflow_id: uuid,
            workflow_name: "Monatsreport",
            classification: "safe",
            age_days: 19,
            stuck: true,
            summary: "Feld umbenannt: total → total_amount",
          },
          {
            id: uuid,
            workflow_id: uuid,
            workflow_name: "Umsatzrollup",
            classification: "unsafe",
            age_days: 1,
            stuck: false,
            summary: "Antwort enthält ein zusätzliches Feld",
          },
        ],
      },
      risk: [],
      rendered: "Attention needed",
      all_clear: false,
    });
  if (path === "/v1/secret-approvals" && request.method() === "GET")
    return json(route, {
      items: [
        {
          name: "settings.llm.api_key",
          version: 4,
          reference: "secret://settings.llm.api_key#4",
          prepared_by: "operator@example.com",
          pending_since: new Date(SWEEP_NOW - 3 * 3_600_000).toISOString(),
          bindings: ["llm.api_key"],
        },
        {
          name: "tenants.default.settings.notifications.smtp.password",
          version: 2,
          reference: "secret://tenants.default.settings.notifications.smtp.password#2",
          prepared_by: "deploy@example.com",
          pending_since: new Date(SWEEP_NOW - 26 * 3_600_000).toISOString(),
          bindings: [],
        },
      ],
    });
  if (/^\/v1\/connectors\/[^/]+\/credential$/.test(path) && request.method() === "GET")
    return json(route, {
      mode: "connection",
      environment: "prod",
      connection: { id: "connection-valid", name: "Reporting-Portal", state: "valid" },
      updated_at: new Date(SWEEP_NOW - 6 * 3_600_000).toISOString(),
    });
  if (path === "/v1/settings")
    return json(route, {
      saved_revision: 8,
      active_revision: 7,
      activation_status: "restart_required",
      pending_restart_fields: ["auth.providers"],
      items: settingsWith([
        {
          path: "auth.providers",
          value: [
            { protocol: "api_key", id: "api-key", label: "SubKit API key" },
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
          path: "tokens.monthly_budget",
          value: 150000000,
          meta: {
            source: "tenant",
            scope: "tenant",
            sensitive: false,
            requiresRestart: false,
            description: "Hard cap on tokens consumed per calendar month. 0 = unlimited.",
            kind: "number",
          },
        },
        {
          path: "observability.usage.enabled",
          value: true,
          meta: {
            source: "tenant",
            scope: "tenant",
            sensitive: false,
            requiresRestart: false,
            kind: "boolean",
          },
        },
      ]),
      diagnostics: { pending_restart_keys: [], override_keys: [] },
    });
  if (path === "/v1/identity/users")
    return json(route, {
      items: [
        {
          id: uuid,
          email: "operator@example.com",
          role: "admin",
          status: "active",
        },
        {
          id: REVIEWER_ID,
          email: "reviewer@example.com",
          role: "Revision",
          status: "active",
        },
        {
          id: "018f4b4a-6d33-7b3a-9c2d-0000000000a3",
          email: "drift@example.com",
          role: "enduser",
          status: "invited",
        },
      ],
      diagnostics: { pending_restart_keys: [], override_keys: [] },
    });
  if (path === "/v1/oauth/clients") return json(route, { items: OAUTH_CLIENTS });
  if (path === "/v1/identity/api-keys")
    return json(route, {
      items: API_KEYS,
      diagnostics: { pending_restart_keys: [], override_keys: [] },
    });
  if (path === "/v1/rbac/roles")
    return json(route, {
      items: [
        {
          id: uuid,
          name: "admin",
          description: "Workspace administration",
          is_builtin: true,
        },
        {
          id: "00000000-0000-4000-8000-000000000002",
          name: "metrics_scraper",
          description: "Prometheus scraper: scoped to metrics:read only",
          is_builtin: true,
        },
        {
          id: "00000000-0000-4000-8000-000000000003",
          name: "portal_token_user",
          description: "Backing role for portal-token principals",
          is_builtin: true,
        },
        {
          id: "00000000-0000-4000-8000-000000000004",
          name: "member",
          description: "Day-to-day operator access",
          is_builtin: true,
        },
        {
          id: "00000000-0000-4000-8000-000000000005",
          name: "enduser",
          description: "Portal end-user",
          is_builtin: true,
        },
        {
          id: CUSTOM_ROLE_ID,
          name: "Revision",
          description: "Liest Läufe und das Audit, ändert nichts.",
          is_builtin: false,
        },
      ],
    });
  const roleDetail = /^\/v1\/rbac\/roles\/([^/]+)$/.exec(path);
  if (roleDetail) {
    const id = decodeURIComponent(roleDetail[1]);
    const byId = {
      [uuid]: ENGINE_PERMISSIONS.map((permission) => permission.name),
      [CUSTOM_ROLE_ID]: ["audit:read", "execution:read", "workflow:read"],
      "00000000-0000-4000-8000-000000000004": ["workflow:read", "workflow:run", "execution:read"],
      "00000000-0000-4000-8000-000000000005": ["workflow:run", "execution:read"],
    };
    return byId[id]
      ? json(route, {
          id,
          name: id,
          description: null,
          is_builtin: id !== CUSTOM_ROLE_ID,
          permissions: byId[id],
        })
      : json(route, { error: { code: "not_found", message: "role" } }, 404);
  }
  if (path === "/v1/identity/system-accounts")
    return json(route, {
      items: [{ id: SYSTEM_ACCOUNT_ID, name: "Reporting-Bot", description: null }],
    });
  if (path === "/v1/rbac/groups")
    return json(route, {
      items: [{ id: uuid, name: "Operations", description: "Operators" }],
    });
  if (path === "/v1/rbac/grants")
    return json(route, {
      items: [
        {
          id: uuid,
          subject_type: "group",
          subject_id: uuid,
          resource_type: "workflow",
          resource_id: uuid,
          permission: "workflow:run",
          expires_at: null,
        },
        {
          id: "grant-connector",
          subject_type: "user",
          subject_id: REVIEWER_ID,
          resource_type: "connector",
          resource_id: uuid,
          permission: "connector:test",
          expires_at: "2026-12-31T23:00:00.000Z",
        },
        {
          id: "grant-schedule",
          subject_type: "system_account",
          subject_id: SYSTEM_ACCOUNT_ID,
          resource_type: "schedule",
          resource_id: uuid,
          permission: "schedule:pause",
          expires_at: null,
        },
      ],
    });
  if (path === "/v1/notifications/rules")
    return json(route, {
      items: [
        {
          id: "rule-inbox",
          name: "sk CLI inbox (default)",
          event_pattern:
            "execution.failed,connector.oauth.callback_failed,connector.auth_failed,connector.health_changed,patch.proposed",
          workflow_pattern: "*",
          severity: "info",
          target_workspace_id: "_cli",
          target_channel_id: "_inbox",
          active: true,
        },
        {
          id: "rule-slack",
          name: "Fehlgeschlagene Läufe",
          event_pattern: "execution.*",
          workflow_pattern: "",
          severity: "error",
          target_workspace_id: "T0001",
          target_channel_id: "C0001",
          active: true,
        },
        {
          id: "rule-everything",
          name: "Alles an die Bereitschaft",
          event_pattern:
            "execution.succeeded,execution.failed,execution.refused,workflow.updated,connector.oauth.refreshed,connector.oauth.callback_succeeded,connector.oauth.callback_failed,connector.auth_failed,connector.health_changed,patch.proposed,patch.applied,apikey.rotated,conversation.committed,schedule.*,vendor.custom_integration.quarterly_reconciliation_completed_with_warnings",
          workflow_pattern: "billing-*",
          severity: "warn",
          target_workspace_id: "T0001",
          target_channel_id: "C0001",
          active: false,
        },
      ],
    });
  if (path === "/v1/patch-candidates" && url.searchParams.get("workflow_id") === runWorkflowId)
    return json(route, { total: 0, reviewable_total: 0, items: [] });
  if (path === "/v1/notifications/channels")
    return json(route, {
      items: [
        {
          id: "channel-inbox",
          platform: "sk_cli",
          workspace_id: "_cli",
          channel_id: "_inbox",
          default_severity: "info",
          rate_limit_per_minute: 60,
          circuit_state: "open",
          circuit_open_until: null,
          consecutive_failures: 0,
          active: true,
        },
        {
          id: "channel-slack",
          platform: "slack",
          workspace_id: "T0001",
          channel_id: "C0001",
          default_severity: "error",
          rate_limit_per_minute: 20,
          circuit_state: "open",
          circuit_open_until: new Date(Date.now() + 4 * 60_000).toISOString(),
          consecutive_failures: 10,
          active: true,
        },
        {
          id: "channel-google",
          platform: "google_chat",
          workspace_id: "spaces/AAA",
          channel_id: "spaces/AAA",
          default_severity: "warn",
          rate_limit_per_minute: 10,
          circuit_state: "draining",
          circuit_open_until: null,
          consecutive_failures: 0,
          active: false,
        },
      ],
    });
  if (path === "/v1/rbac/permissions") return json(route, { items: ENGINE_PERMISSIONS });
  if (path === "/v1/patch-candidates")
    return json(route, {
      total: 2,
      reviewable_total: 1,
      items: [
        {
          id: uuid,
          tenant_id: uuid,
          reviewable: true,
          review_reason: null,
          review_digest: "a".repeat(64),
          base_version_id: uuid,
          workflow_id: uuid,
          workflow_name: "Monatsreport",
          connector_id: uuid,
          endpoint_key: `POST /workflows/${uuid}/reports`,
          classification: "safe",
          status: "proposed",
          fixture_id: uuid,
          created_at: new Date(SWEEP_NOW - 36 * 3_600_000).toISOString(),
          updated_at: new Date(SWEEP_NOW - 36 * 3_600_000).toISOString(),
          diff: {
            execution_id: uuid,
            step_id: "fetch",
            workflow_step_id: "fetch",
            drift_diff: "kind: schema_diff\nwidened: data.id\nadded: data.result\nremoved: (none)",
            drift_signal: { kind: "schema_diff" },
            classification_reasons: ["field rename only", "no new outbound host"],
            proposal: {
              classification: "safe",
              kind: "update_field_path",
              description: "Feld folgt der Umbenennung: data.id → data.result.id",
              patch: { path: "data.id", value: "data.result.id" },
              reasoning: `Die Antwort trägt die Kennung seit dem 8. August unter result. Lauf ${uuid} liest weiterhin den alten Pfad und bekommt deshalb undefined.`,
            },
          },
        },
        {
          id: "patch-2",
          reviewable: false,
          review_reason: "no_step_anchor",
          review_digest: null,
          base_version_id: uuid,
          tenant_id: uuid,
          workflow_id: uuid,
          workflow_name: "Umsatzrollup",
          connector_id: null,
          endpoint_key: null,
          classification: "unsafe",
          status: "proposed",
          fixture_id: null,
          created_at: "2026-08-05T07:00:00.000Z",
          updated_at: "2026-08-05T07:00:00.000Z",
          diff: {
            execution_id: null,
            drift_diff: `kind: stdlib_version_drift\nresource_id: ${uuid}\nrecorded_major: 1\ncurrent_major: 2`,
            drift_signal: { kind: "stdlib_version_drift" },
            classification_reasons: ["major version change", "no fixture to replay against"],
            rejection_chain: [
              {
                attempt: 1,
                reason: "unsafe classification (major version change) and no fixture",
              },
            ],
            proposal: {
              classification: "unsafe",
              kind: "other",
              description: "Baustein anheben",
            },
          },
        },
      ],
    });
  if (path === `/v1/patch-candidates/${uuid}/preview`)
    return json(route, {
      candidate_id: uuid,
      reviewable: true,
      review_reason: null,
      review_digest: "a".repeat(64),
      base_version_id: uuid,
      workflow_id: uuid,
      classification: "safe",
      status: "proposed",
      drift_summary: "kind: schema_diff\nwidened: data.id",
      fixture_available: true,
      before_step: { id: "fetch", kind: "request", data_selector: "data.id" },
      after_step: {
        id: "fetch",
        kind: "request",
        data_selector: "data.result.id",
      },
      changed_paths: ["data_selector"],
      proposal: { kind: "update_field_path", patch: { path: "data.id" } },
    });
  if (path === `/v1/patch-candidates/${uuid}/dry-run`)
    return json(route, {
      ok: true,
      error: null,
      value_preview: '{ "id": "rep_8842" }',
      fixture_source: "recorded",
    });
  if (path === `/v1/skill-candidates/${uuid}/evidence`)
    return json(route, {
      items: [
        {
          id: "ev-1",
          skill_candidate_id: uuid,
          execution_id: uuid,
          patch_candidate_id: null,
          evidence_type: "step_failure",
          summary: "Schritt fetch lief nach dem Feldwechsel ins Leere",
          captured_at: "2026-08-09T07:00:00.000Z",
        },
        {
          id: "ev-2",
          skill_candidate_id: uuid,
          execution_id: null,
          patch_candidate_id: uuid,
          evidence_type: "patch_applied",
          summary: "Dieselbe Korrektur hat den Lauf danach repariert",
          captured_at: "2026-08-08T07:00:00.000Z",
        },
      ],
    });
  if (path === "/v1/skill-candidates") {
    const candidate = (overrides) => ({
      id: uuid,
      tenant_id: uuid,
      scope: "workflow",
      connector_id: null,
      endpoint_key: null,
      workflow_id: uuid,
      pattern_kind: "repair_pattern",
      title: "Umbenannte Antwortfelder zuerst prüfen",
      body: "Wenn ein Schritt plötzlich undefined liest, hat das System meist ein Feld verschoben statt es zu entfernen.\n\nErst die Antwortstruktur mit der aufgezeichneten vergleichen, dann den Pfad nachziehen — ein neuer Aufruf ist selten nötig.",
      examples: [`data.id wurde zu data.result.id (Lauf ${uuid})`],
      best_practices: ["Aufgezeichnete Antwort als Vergleich heranziehen"],
      pitfalls: ["Nicht den ganzen Schritt neu schreiben, nur den Pfad"],
      doc_refs: ["docs/concepts/self-healing.md"],
      facts: null,
      evidence_count: 2,
      confidence: "high",
      status: "proposed",
      promoted_skill_id: null,
      reviewable: true,
      review_digest: "a".repeat(64),
      fingerprint: "fp-1",
      version: 1,
      tags: ["domain:reporting"],
      created_at: new Date(SWEEP_NOW - 20 * 3_600_000).toISOString(),
      updated_at: new Date(SWEEP_NOW - 20 * 3_600_000).toISOString(),
      ...overrides,
    });
    const rows = [
      candidate({}),
      candidate({
        id: "018f4b4a-6d33-7b3a-9c2d-0000000000a1",
        pattern_kind: "authoring_capability",
        connector_id: uuid,
        title: "Workflow 'beispiel-bericht' capabilities",
        body: `Workflow 'Beispiel-Bericht' (slug beispiel-bericht) — what it does and how to invoke it.\nInputs: none declared.\nOutput fields: not declared.\nConnectors: ${uuid}.`,
        examples: [],
        best_practices: [],
        pitfalls: [],
        doc_refs: [],
        facts: {
          kind: "workflow_capability",
          inputs: [{ name: "limit", type: "integer", required: true }],
          output_fields: null,
          key_paths: ["items", "total"],
          connector_ids: [uuid],
          steps: [
            { id: "fetch", kind: "request" },
            { id: "shape", kind: "transform" },
          ],
          draft_version_id: "018f4b4a-6d33-7b3a-9c2d-0000000000b1",
        },
        evidence_count: 1,
        status: "context",
        reviewable: false,
        review_digest: "b".repeat(64),
        fingerprint: "fp-2",
        tags: [],
      }),
      candidate({
        id: "018f4b4a-6d33-7b3a-9c2d-0000000000a2",
        pattern_kind: "failure_pattern",
        title: "Recurring failure on step 'write_products'",
        body: "Step 'write_products' fails with 'request_outside_declared_boundary' consistently (3 times in 30 days). Consider adding input validation or a guard step.",
        examples: ["3 failures with error kind 'request_outside_declared_boundary'"],
        best_practices: ["Add input validation before this step"],
        pitfalls: [],
        doc_refs: [],
        facts: {
          kind: "recurring_failure",
          step_key: "write_products",
          error_kind: "request_outside_declared_boundary",
          cause_class: "authority_mismatch",
          count: 3,
          lookback_days: 30,
        },
        evidence_count: 3,
        confidence: "low",
        status: "context",
        reviewable: false,
        review_digest: "c".repeat(64),
        fingerprint: "fp-3",
        tags: [],
      }),
    ];
    const status = url.searchParams.get("status");
    const workflowId = url.searchParams.get("workflow_id");
    const matching = rows.filter(
      (row) =>
        (!status || row.status === status) && (!workflowId || row.workflow_id === workflowId),
    );
    return json(route, {
      items: matching,
      total: matching.length,
      reviewable_total: matching.filter((row) => row.status === "proposed").length,
    });
  }

  const label = path.split("/").filter(Boolean).at(-1)?.replaceAll("-", " ") || "record";
  return json(route, {
    items: Array.from({ length: 14 }, (_, index) => ({
      id: uuid,
      tenant_id: uuid,
      name: `${label.charAt(0).toUpperCase()}${label.slice(1)} Beispiel ${index + 1} mit einem sehr langen verständlichen Namen`,
      status: "active",
      type: `workspace-${"long-value-".repeat(5)}${index + 1}`,
      created_at: "2026-08-10T07:00:00.000Z",
    })),
  });
}

export {
  ACTIVE_KEY_NAMES,
  API_KEY_BASE,
  API_KEYS,
  ATTENTION_ENGINE_DETAIL,
  ATTENTION_ITEMS,
  ATTENTION_SOURCES,
  AUDIT_FIXTURE_ENTRIES,
  AUDIT_FIXTURE_ROWS,
  AUDIT_PAGED_ENTRIES,
  AUDIT_PAGING_TAIL,
  assertAuditFixtureActionsAreReal,
  attentionAnswer,
  attentionEntry,
  BLOCKED_WORKFLOW_ID,
  baseMessages,
  CATALOG_META,
  CONNECTIONS,
  CUSTOM_ROLE_ID,
  conversation,
  conversations,
  ENGINE_SETTINGS,
  focused,
  hostileAuthority,
  json,
  messages,
  mockApi,
  OAUTH_CLIENTS,
  pageOf,
  REAL_OAUTH_CLIENTS,
  REVIEWER_ID,
  ROUTE_FILTER,
  routes,
  runConnectorId,
  runVersionId,
  runWorkflowId,
  SETTINGS_SECTION_COUNT,
  STAND_FILTER,
  SWEEP_NOW,
  SYSTEM_ACCOUNT_ID,
  settingsWith,
  sse,
  standOn,
  sweepList,
  sweptRoutes,
  toolTurn,
  uuid,
  workflowInvocation,
};
