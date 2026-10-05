import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { AuditAction } from "../apps/engine/src/audit/types.ts";
import { leafSchemaMeta, listConfigLeaves } from "../apps/engine/src/config/walk.ts";
import ENGINE_PERMISSIONS from "../apps/engine/src/rbac/permissions.json" with { type: "json" };
import { verifyApiAccess } from "./lib/cockpit-api-access.mjs";
import { verifyChatActivation } from "./lib/cockpit-chat-activation.mjs";
import { verifyChatActivity } from "./lib/cockpit-chat-activity.mjs";
import { verifyChatApprovals, verifyChatDecidedApproval } from "./lib/cockpit-chat-approvals.mjs";
import { verifyChatChoices } from "./lib/cockpit-chat-choices.mjs";
import { assertChatLayout } from "./lib/cockpit-chat-layout.mjs";
import { verifyChatOAuth } from "./lib/cockpit-chat-oauth.mjs";
import { verifyChatReauth } from "./lib/cockpit-chat-reauth.mjs";
import { verifyChatReplies } from "./lib/cockpit-chat-replies.mjs";
import { verifyConnectorDetail } from "./lib/cockpit-connector-detail.mjs";
import { verifyCreateConnector } from "./lib/cockpit-create-connector.mjs";
import { verifyDecisionLifecycle } from "./lib/cockpit-decisions.mjs";
import { verifyDetailAction } from "./lib/cockpit-detail-action.mjs";
import { verifyGateDiagnosis } from "./lib/cockpit-gate-diagnosis.mjs";
import { verifyChatReviewCard, verifyGrantDialog } from "./lib/cockpit-grant-dialog.mjs";
import { verifyHookHolds } from "./lib/cockpit-hook-holds.mjs";
import { standAt } from "./lib/cockpit-identity.mjs";
import { verifyInstallationPages } from "./lib/cockpit-installation.mjs";
import { verifyLoadFailures } from "./lib/cockpit-load-failures.mjs";
import { verifyRunDialog } from "./lib/cockpit-run-dialog.mjs";
import { verifyScheduleHolds } from "./lib/cockpit-schedule-holds.mjs";
import {
  assertSingleTriggers,
  isSheetView,
  patternMigratedView,
  patternViewRoot,
  TRANSCRIPT,
} from "./lib/cockpit-single-trigger.mjs";
import { assertNoVisibleUuids } from "./lib/cockpit-visible-uuids.mjs";
import { verifyWorkflowAuthorities } from "./lib/cockpit-workflow-authorities.mjs";
import { verifyWorkflowPage } from "./lib/cockpit-workflow-page.mjs";
import { verifyWorkflowPreview } from "./lib/cockpit-workflow-preview.mjs";

function freePort() {
  return new Promise((ok, no) => {
    const probe = createServer();
    probe.once("error", no);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

async function startPreviewServer() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    "bunx",
    [
      "vite",
      "preview",
      "--config",
      "apps/cockpit/vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const stop = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  process.on("exit", stop);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(
        `Cockpit visual sweep NOT TAKEN — the preview server exited with code ${child.exitCode} before serving ${baseUrl}/cockpit/.`,
      );
    const answered = await fetch(`${baseUrl}/cockpit/`)
      .then((res) => res.ok)
      .catch(() => false);
    if (answered) return { baseUrl, stop };
    await new Promise((ok) => setTimeout(ok, 250));
  }
  stop();
  throw new Error(
    `Cockpit visual sweep NOT TAKEN — the preview server never answered on ${baseUrl}/cockpit/ within 30 s.`,
  );
}

const spawnedPreview = process.env.COCKPIT_BASE_URL ? null : await startPreviewServer();
const baseUrl = (process.env.COCKPIT_BASE_URL || spawnedPreview.baseUrl).replace(/\/$/, "");
const outputDir = resolve(process.env.COCKPIT_SCREENSHOT_DIR || ".artifacts/cockpit-sweep/local");
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
  "settings?tab=benachrichtigungen",
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
        href: `/cockpit?runs=all&workflow_id=${runWorkflowId}&status=failed`,
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

async function mockApi(route) {
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
      permissions: [
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
      description: null,
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
  if (
    [
      "/v1/workflows",
      "/v1/connectors",
      "/v1/knowledge-sources",
      "/v1/skills",
      "/v1/files",
    ].includes(path)
  ) {
    const rowFor = (index) => {
      const rotate = index % 4;
      if (path === "/v1/workflows")
        return {
          slug: `reporting-monatsreport-${index}`,
          name:
            index === 1
              ? "Monatsreport für alle Tochtergesellschaften inklusive Nachbuchungen und Konsolidierung"
              : `Monatsreport ${index + 1}`,
          category: index % 2 === 0 ? "reporting" : "betrieb",
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
          category: index % 2 === 0 ? "reporting" : "betrieb",
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
      };
    });
    const status = url.searchParams.get("status");
    const limit = Number(url.searchParams.get("limit") ?? "0");
    const narrowed = status ? items.filter((item) => item.status === status) : items;
    return json(route, {
      items: limit > 0 ? narrowed.slice(0, limit) : narrowed,
      total: status ? narrowed.length : 240,
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
    const window = { started_from: from, started_to: to };
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
        failed_href: `/cockpit?${new URLSearchParams({ runs: "all", status: "failed", ...window })}`,
      },
      connectors: {
        enabled: 32,
        not_ok: 21,
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
        body: `Workflow 'Beispiel-Bericht' (slug beispiel-bericht) — what it does and how to invoke it.\nInputs: none declared.\nOutput shape: unknown.\nConnectors: ${uuid}.`,
        examples: [],
        best_practices: [],
        pitfalls: [],
        doc_refs: [],
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

function artifactRouteName(route) {
  const [rawPath, query] = route.split("?");
  const name = (rawPath || "overview").replace(/\/[^/]+$/, "-record");
  return query ? `${name}-${query.replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "")}` : name;
}

function markerFor(route) {
  const path = route.split("?")[0];
  if (/^workflows\/.+/.test(path)) return '[data-testid="workflow-invocation"]';
  if (/^connectors\/.+/.test(path)) return '[data-testid="connector-strip-state"]';
  if (/^files\/.+/.test(path)) return '[data-testid="file-sheet"] [data-testid="file-facts"]';
  if (path === "files") return '[data-testid="files-page"]';
  if (/^(knowledge|skills)\/.+/.test(path))
    return `[data-testid="detail-${path.split("/")[0]}"] [data-testid="detail-overview"]`;
  if (path === "chat") return '[data-testid="chat-workspace"]';
  const query = route.split("?")[1] ?? "";
  if (/(^|&)run=/.test(query)) return '[data-testid="run-detail-summary"]';
  if (/(^|&)runs=all/.test(query)) return '[data-testid="resource-runs"]';
  if (path === "")
    return query.startsWith("review=")
      ? '[data-testid="attention-review-body"]'
      : '[data-testid="attention-list"]';
  if (path === "access") return '[data-testid="roles-section"]';
  if (path === "people" && query.startsWith("section="))
    return `[data-testid="${query.slice("section=".length)}-section"]`;
  if (path === "api-access" && query.startsWith("section="))
    return `[data-testid="api-access-section-${query.slice("section=".length)}"]`;
  if (path === "settings" && query === "tab=benachrichtigungen")
    return '[data-testid="notifications-rules"]';
  if (path === "settings" && query.startsWith("section="))
    return `[data-testid="settings-section-${query.slice("section=".length)}"]`;
  if (["people", "api-access", "settings"].includes(path)) return `[data-testid="admin-${path}"]`;
  if (["workflows", "connectors", "knowledge", "skills", "files"].includes(path))
    return `[data-testid="catalog-${path}"]`;
  return `[data-testid="resource-${path}"]`;
}

function documentThemeMatches(classes, theme) {
  const dark = classes?.split(/\s+/).includes("dark") ?? false;
  return theme === "dark" ? dark : !dark;
}

async function assertNoHorizontalScroll(page, label) {
  const found = await page.evaluate(() => {
    const width = window.innerWidth;
    const inScroller = (node) => {
      for (let up = node.parentElement; up; up = up.parentElement) {
        const x = window.getComputedStyle(up).overflowX;
        if ((x === "auto" || x === "scroll") && up.getBoundingClientRect().right <= width + 1)
          return true;
      }
      return false;
    };
    const containers = [
      ...document.querySelectorAll(
        '[data-testid="page-content"], [data-family-slot="scroll-region"], [data-family-slot="content"], main[data-page-kind]',
      ),
    ]
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .flatMap((node) => {
        const frame = node.getBoundingClientRect();
        const inner = frame.left + node.clientWidth;
        const clipped = (el) => {
          for (let up = el.parentElement; up && up !== node; up = up.parentElement) {
            const x = window.getComputedStyle(up).overflowX;
            if (x === "auto" || x === "scroll" || x === "hidden" || x === "clip") return true;
          }
          return false;
        };
        let widest = null;
        for (const child of node.querySelectorAll("*")) {
          const right = child.getBoundingClientRect().right;
          if (right > inner + 1 && !clipped(child) && (!widest || right > widest.right))
            widest = { child, right };
        }
        const name = (el) =>
          el.getAttribute("data-testid") ?? el.getAttribute("data-slot") ?? el.tagName;
        if (widest && widest.right <= width + 1) return [];
        const culprit = widest
          ? ` (${name(widest.child)} reaches ${Math.round(widest.right)}px of ${Math.round(inner)}px)`
          : "";
        return [
          `${node.getAttribute("data-testid") ?? node.tagName} is wider than its frame${culprit}`,
        ];
      });
    const poking = [...document.querySelectorAll("body *")]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || rect.right <= width + 1) return false;
        const style = window.getComputedStyle(node);
        if (style.visibility === "hidden" || style.position === "fixed") return false;
        return !inScroller(node);
      })
      .slice(0, 3)
      .map(
        (node) =>
          `${node.getAttribute("data-testid") ?? node.tagName} reaches ${Math.round(node.getBoundingClientRect().right)}px`,
      );
    return [...containers, ...poking];
  });
  if (found.length) throw new Error(`${label} scrolls sideways: ${found.join(", ")}`);
}

async function assertViewport(page, label) {
  const geometry = await page.evaluate(() => {
    const content = document.querySelector('[data-testid="page-content"]');
    if (!(content instanceof HTMLElement)) throw new Error("page content missing");
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      bodyWidth: document.body.scrollWidth,
      bodyHeight: document.body.scrollHeight,
      contentWidth: content.scrollWidth,
      contentClientWidth: content.clientWidth,
      contentBottom: content.getBoundingClientRect().bottom,
    };
  });
  if (
    geometry.bodyWidth > geometry.viewportWidth + 1 ||
    geometry.contentWidth > geometry.contentClientWidth + 1
  )
    throw new Error(`${label} has horizontal overflow`);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[role="dialog"]')].every((sheet) =>
        sheet.getAnimations().every((animation) => animation.playState !== "running"),
      ),
    undefined,
    { timeout: 5_000 },
  );
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"]')].flatMap((sheet) => {
      const edge = sheet.getBoundingClientRect().right;
      return [...sheet.querySelectorAll("*")]
        .filter((node) => {
          if (node.getBoundingClientRect().right <= edge + 1) return false;
          for (let up = node.parentElement; up && up !== sheet; up = up.parentElement) {
            const x = window.getComputedStyle(up).overflowX;
            if (x === "auto" || x === "scroll") return false;
          }
          return true;
        })
        .slice(0, 3)
        .map(
          (node) =>
            `${node.getAttribute("data-testid") ?? node.tagName} "${(node.textContent ?? "").trim().slice(0, 40)}"`,
        );
    }),
  );
  if (clipped.length)
    throw new Error(`${label} has a sheet cut off at its edge: ${clipped.join(", ")}`);
  if (
    geometry.bodyHeight > geometry.viewportHeight + 1 ||
    geometry.contentBottom > geometry.viewportHeight + 1
  )
    throw new Error(`${label} grows beyond the viewport`);
}

async function assertOpenOnce(page, label) {
  if (await page.locator('[data-testid^="data-table-open-"]').count())
    throw new Error(`${label}: a row still carries an "Öffnen" button`);
  if (await page.locator('[data-family-collection-row="true"][tabindex="0"]').count())
    throw new Error(`${label}: a row is a tab stop beside its own link`);
  let open = page.locator('[data-testid="data-table-row-link-0"]');
  if (!(await open.isVisible().catch(() => false)))
    open = page.locator('[data-testid="data-table-mobile-row-link-0"]');
  if (!(await open.isVisible().catch(() => false)))
    throw new Error(`${label}: the first run names itself with no link`);
  const href = await open.getAttribute("href");
  if (!href || !/^\/cockpit\?(?:[^#]*&)?run=[^&#]+/.test(href))
    throw new Error(`${label}: the run link leads to ${href}, not to the run's own address`);
  const before = await page.evaluate(() => window.history.length);
  await open.focus();
  await page.keyboard.press("Enter");
  await page
    .locator('[data-testid="run-detail-summary"]')
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(async () => {
      const sheet = await page
        .locator('[role="dialog"]')
        .last()
        .innerText()
        .catch(() => "");
      throw new Error(
        `${label}: Enter on the run's link opened no run (${page.url()}): ${sheet.slice(0, 300)}`,
      );
    });
  const after = await page.evaluate(() => window.history.length);
  if (after - before !== 1)
    throw new Error(
      `${label}: Enter on the run's link added ${after - before} history entries — the record opened more than once`,
    );
  await page.goBack();
  await page.locator('[data-testid="run-detail"]').waitFor({ state: "hidden" });
  await page.locator('[data-testid="resource-runs"]').waitFor({ state: "visible" });
}

async function assertOverviewHostile(page, label, language) {
  const shape = await page.evaluate(() => {
    const entries = [
      ...document.querySelectorAll('[data-testid="attention-list"] [data-attention-id]'),
    ].filter((entry) => entry.getClientRects().length > 0);
    return {
      ids: entries.map((entry) => entry.getAttribute("data-attention-id")),
      primaries: entries.map((entry) => entry.querySelectorAll('[data-testid$="-primary"]').length),
      secondaries: entries.map(
        (entry) => entry.querySelectorAll('[data-testid$="-secondary"]').length,
      ),
      text: document.querySelector('[data-testid="attention-page"]')?.innerText ?? "",
      status: document.querySelectorAll('[data-testid="attention-status"]').length,
      calm: document.querySelectorAll('[data-testid="attention-calm"]').length,
      unread: document.querySelector('[data-testid="attention-unread"]')?.textContent ?? null,
      badge: document.querySelector('[data-testid="nav-overview-count"]')?.textContent ?? null,
    };
  });
  const expected = ATTENTION_ITEMS.map((item) => item.id);
  if (shape.ids.join("|") !== expected.join("|"))
    throw new Error(`${label}: entries ${shape.ids.join(", ")} — the engine sent ${expected}`);
  if (shape.primaries.some((count) => count !== 1))
    throw new Error(`${label}: an entry without exactly one primary action`);
  if (shape.secondaries.some((count) => count > 1))
    throw new Error(`${label}: an entry with more than one secondary link`);
  if (shape.badge !== null && Number(shape.badge) !== expected.length)
    throw new Error(`${label}: the badge says ${shape.badge}, the list holds ${expected.length}`);
  if (shape.calm || shape.status)
    throw new Error(`${label}: "all done" or a status line beside open entries`);
  if (!shape.unread?.includes(language === "de" ? "Betriebssignale" : "operating signals"))
    throw new Error(`${label}: the failed source is not named (${shape.unread})`);
  if (shape.text.includes(ATTENTION_ENGINE_DETAIL))
    throw new Error(`${label}: the engine's wording stands on the list`);
  const blocked = await page.evaluate((id) => {
    const entry = [...document.querySelectorAll(`[data-attention-id="workflow:${id}"]`)].find(
      (node) => node.getClientRects().length > 0,
    );
    const row = entry?.closest('tr, [data-testid*="mobile-row"]');
    return {
      text: row?.textContent ?? "",
      action: entry?.querySelector('[data-testid$="-primary"]')?.textContent?.trim() ?? "",
    };
  }, BLOCKED_WORKFLOW_ID);
  const wants =
    language === "de"
      ? { sentence: "blockiert", action: "Vorbereitung ausführen", refused: "Freigeben" }
      : { sentence: "blocked", action: "Run the preparation", refused: "Approve" };
  if (!blocked.text.includes(wants.sentence) || !blocked.text.includes("send_notification_email"))
    throw new Error(`${label}: the blocked version does not name its step (${blocked.text})`);
  if (blocked.action !== wants.action || blocked.action === wants.refused)
    throw new Error(`${label}: the blocked version offers "${blocked.action}"`);
  await assertOperationsBar(page, label);
}

async function assertOperationsBar(page, label) {
  await page.locator('[data-testid="operations-bar"] [data-figure-state]').first().waitFor();
  const shape = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="operations-bar"]');
    const figures = [...(bar?.querySelectorAll("[data-figure-state]") ?? [])];
    const below = document.querySelector(
      '[data-testid="attention-list"], [data-testid="attention-calm"]',
    );
    return {
      count: figures.length,
      rows: new Set(figures.map((figure) => Math.round(figure.getBoundingClientRect().top))).size,
      columns: new Set(figures.map((figure) => Math.round(figure.getBoundingClientRect().left)))
        .size,
      height: Math.max(...figures.map((figure) => figure.getBoundingClientRect().height)),
      belowTop: below ? below.getBoundingClientRect().top : null,
      links: [...(bar?.querySelectorAll("a") ?? [])].map((link) => link.getAttribute("href")),
      innerHeight: window.innerHeight,
      phone: window.innerWidth < 640,
      overflow: bar ? bar.scrollWidth > bar.clientWidth + 1 : false,
      budget: (bar?.querySelector('[data-testid="operations-figure-budget"]')?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      pressure:
        bar
          ?.querySelector('[data-testid="operations-figure-budget"]')
          ?.getAttribute("data-budget-pressure") ?? null,
    };
  });
  if (shape.count !== 4)
    throw new Error(`${label}: the operations bar holds ${shape.count} figures`);
  const grids = shape.phone
    ? [[2, 2]]
    : [
        [1, 4],
        [2, 2],
      ];
  if (!grids.some(([rows, columns]) => shape.rows === rows && shape.columns === columns))
    throw new Error(
      `${label}: the figures stand in ${shape.rows}×${shape.columns}, not ${grids
        .map((grid) => grid.join("×"))
        .join(" or ")}`,
    );
  if (shape.overflow) throw new Error(`${label}: the operations bar scrolls sideways`);
  if (shape.height > 96)
    throw new Error(`${label}: a figure is ${shape.height}px tall, not compact`);
  if (shape.belowTop !== null && shape.belowTop > shape.innerHeight)
    throw new Error(`${label}: the bar pushes what needs the reader below the first screen`);
  for (const href of shape.links)
    if (!/started_from=|ts_from=|health=not_ok|\/usage(\?window=24h)?$/.test(href ?? ""))
      throw new Error(`${label}: a figure links to ${href}, not to the list of its window`);
  if (!/412[,.]87/.test(shape.budget ?? ""))
    throw new Error(
      `${label}: the usage figure does not lead with the month's money: "${shape.budget}"`,
    );
  if (!/95\s*%/.test(shape.budget ?? "") || shape.pressure !== "critical")
    throw new Error(`${label}: the budget figure reads "${shape.budget}" (${shape.pressure})`);
}

async function assertUsageOrigins(page, label) {
  await page.locator('[data-testid="usage-origin"]:visible').first().waitFor();
  const shape = await page.evaluate(() => ({
    origins: [...document.querySelectorAll('[data-testid="usage-origin"]')]
      .filter((cell) => cell.getClientRects().length > 0)
      .map((cell) => ({
        origin: cell.getAttribute("data-origin"),
        text: (cell.textContent ?? "").trim(),
      })),
    sections: [
      ...document.querySelectorAll(
        '[data-testid="usage-origins"], [data-testid="usage-breakdown"], [data-testid="usage-models"]',
      ),
    ].map((section) => section.getAttribute("data-testid")),
    breakdown: (
      document.querySelector('[data-testid="usage-breakdown"]')?.textContent ?? ""
    ).trim(),
  }));
  const origins = shape.origins.map((row) => row.origin).sort();
  const expected = [
    "authoring",
    "chat",
    "knowledge",
    "other",
    "reviews",
    "summaries",
    "workflowRuns",
  ];
  if (origins.join("|") !== expected.join("|"))
    throw new Error(`${label}: the origin table holds ${origins.join(", ")}`);
  if (shape.origins[0]?.origin !== "chat")
    throw new Error(`${label}: the origin table does not lead with the largest, chat`);
  const other = shape.origins.find((row) => row.origin === "other");
  if (!other?.text.includes("some_future_flow"))
    throw new Error(`${label}: "Sonstiges" does not name the flow it holds: "${other?.text}"`);
  if (shape.sections.join("|") !== "usage-origins|usage-breakdown|usage-models")
    throw new Error(`${label}: the usage sections stand as ${shape.sections.join(", ")}`);
  if (/Keinem zuzuordnen|Not attributable/.test(shape.breakdown))
    throw new Error(`${label}: the workflow table still carries the catch-all row`);
}

async function assertReviewCloseLeavesNoTrail(page, label) {
  const open = page
    .locator('[data-testid="attention-list"] [data-attention-verb="review"]:visible')
    .first();
  const sheet = page.locator('[data-testid="attention-review"]');
  await stand.visit(page, "usage");
  await stand.visit(page, "");
  await open.click();
  await sheet.waitFor({ state: "visible" });
  await page.locator('[data-testid="attention-review-close"]').click();
  await sheet.waitFor({ state: "hidden" });
  if (new URL(page.url()).searchParams.get("review"))
    throw new Error(`${label}: the closed sheet is still in the address`);
  await page.goBack();
  await page
    .locator('[data-testid="resource-usage"], [data-testid="admin-usage"]')
    .first()
    .waitFor({
      state: "attached",
      timeout: 10_000,
    })
    .catch(() => {});
  const url = new URL(page.url());
  if ((await sheet.isVisible().catch(() => false)) || url.searchParams.has("review"))
    throw new Error(`${label}: Back after closing reopens the review sheet`);
  if (!url.pathname.endsWith("/usage"))
    throw new Error(
      `${label}: Back after closing lands on ${url.pathname}, not where the reader was`,
    );
}

async function verifyOverviewCalm(page, label, language, capture) {
  const pattern = "**/v1/attention*";
  const calm = (route) => route.fulfill({ json: attentionAnswer({ items: [], failed: [] }) });
  await page.route(pattern, calm);
  try {
    await stand.visit(page, "");
    const list = page.locator('[data-testid="attention"][data-family-state="empty"]');
    await list.waitFor({ state: "visible" });
    const shape = await page.evaluate(() => ({
      badge: document.querySelectorAll('[data-testid="nav-overview-count"]').length,
      text: document.querySelector('[data-testid="attention"]')?.innerText ?? "",
      summary: document.querySelector('[data-testid="overview-summary"]')?.innerText ?? "",
    }));
    if (shape.badge) throw new Error(`${label}: a badge although nothing is open`);
    await assertOperationsBar(page, label);
    if (
      !shape.text.includes(language === "de" ? "Nichts braucht dich gerade" : "Nothing needs you")
    )
      throw new Error(`${label}: the calm state reads "${shape.text}"`);
    if (!/^0\b/.test(shape.summary.trim()))
      throw new Error(`${label}: the summary does not count zero ("${shape.summary}")`);
    await capture();
  } finally {
    await page.unroute(pattern, calm);
  }
}

async function assertUnhealthyConnectorsOnly(page, label) {
  if (!(await page.locator('[data-testid="catalog-health-filter"]').isVisible()))
    throw new Error(`${label}: the health narrowing is not shown as a removable chip`);
  const rows = await page.locator('[data-testid="catalog-connectors"] tbody').innerText();
  for (const shown of ["Mailer", "Legacy CRM"])
    if (!rows.includes(shown)) throw new Error(`${label}: ${shown} is unhealthy and missing`);
  for (const hidden of ["Reporting API", "Warehouse"])
    if (rows.includes(hidden)) throw new Error(`${label}: ${hidden} is listed but not unhealthy`);
}

async function assertNotificationRules(page, label) {
  const machineValues = (index) =>
    page
      .locator(`[data-testid="notifications-rule-${index}"] [data-machine-value="true"]`)
      .allInnerTexts();
  if ((await machineValues(0)).length !== 0)
    throw new Error(`${label}: the seeded rule prints an event as the engine's value`);
  const hostile = (await machineValues(2)).join(" | ");
  if (
    hostile !==
    "vendor.custom_integration.quarterly_reconciliation_completed_with_warnings | billing-*"
  )
    throw new Error(`${label}: the hostile rule marks ${hostile}, not its one unknown event`);
  const clipped = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="notifications-rules"]');
    if (!card) return ["the rules card is missing"];
    const edge = card.getBoundingClientRect().right;
    return [...card.querySelectorAll('[data-testid^="notifications-rule-"]')]
      .filter((rule) => rule.getBoundingClientRect().right > edge + 1)
      .map((rule) => rule.getAttribute("data-testid"));
  });
  if (clipped.length > 0)
    throw new Error(`${label}: rules wider than their card: ${clipped.join(", ")}`);
  const openRow = async (table, index, sheet) => {
    await page
      .locator(
        `[data-testid="${table}-row-link-${index}"], [data-testid="${table}-mobile-row-link-${index}"]`,
      )
      .filter({ visible: true })
      .first()
      .click();
    await page.getByTestId(sheet).waitFor({ state: "visible" });
  };
  const closeSheet = async (sheet) => {
    await page.getByTestId(sheet).locator('[data-slot="sheet-close"]').click();
    await page.getByTestId(sheet).waitFor({ state: "detached" });
  };
  await openRow("notifications-rules-table", 1, "notifications-rule-sheet");
  const ruleSheet = page.getByTestId("notifications-rule-sheet");
  await ruleSheet.getByTestId("action-menu").click();
  if (!(await page.getByTestId("notifications-rule-delete").isEnabled()))
    throw new Error(`${label}: a rule's sheet offers no way to delete it`);
  if (!(await page.getByTestId("notifications-rule-toggle").isVisible()))
    throw new Error(`${label}: a rule's sheet offers no way to pause it`);
  await page.keyboard.press("Escape");
  await page.getByTestId("notifications-rule-edit").click();
  const ruleDialog = page.getByTestId("notifications-rule-dialog");
  await ruleDialog.waitFor({ state: "visible" });
  if (!(await page.getByTestId("notifications-rule-name").inputValue()).trim())
    throw new Error(`${label}: editing a rule does not start from its name`);
  await page.getByTestId("notifications-rule-dialog-cancel").click();
  await ruleDialog.waitFor({ state: "detached" });
  await closeSheet("notifications-rule-sheet");
  await openRow("notifications-channels-table", 1, "notifications-channel-sheet");
  if (!(await page.getByTestId("notifications-channel-delete").isDisabled()))
    throw new Error(`${label}: a channel two rules deliver to can be removed`);
  await closeSheet("notifications-channel-sheet");
  await openRow("notifications-channels-table", 2, "notifications-channel-sheet");
  if (!(await page.getByTestId("notifications-channel-delete").isEnabled()))
    throw new Error(`${label}: an unused channel cannot be removed`);
  await closeSheet("notifications-channel-sheet");
}

const ENDLESS_LISTS = {
  workflows: { path: "/v1/workflows", firstPage: 25, paging: "offset" },
  audit: { path: "/v1/audit-log", firstPage: 50, paging: "cursor" },
};

async function assertEndlessList(page, label, route) {
  const list = ENDLESS_LISTS[route];
  const desktop = await page.locator('[data-testid="data-table-desktop"]').isVisible();
  const row = (index) =>
    page.locator(`[data-testid="data-table-${desktop ? "row" : "mobile-row"}-${index}"]`);
  await row(0).waitFor();
  if ((await row(list.firstPage).count()) > 0) {
    const filled = await page.evaluate((mobile) => {
      const scope = document.querySelector(
        `[data-testid="data-table-${mobile ? "mobile" : "desktop"}"]`,
      );
      for (let box = scope; box; box = box.parentElement)
        if (
          /auto|scroll/.test(getComputedStyle(box).overflowY) &&
          box.scrollHeight > box.clientHeight
        )
          return true;
      return document.documentElement.scrollHeight > window.innerHeight;
    }, !desktop);
    if (!filled)
      throw new Error(
        `${label}: row ${list.firstPage + 1} loaded before scrolling, yet the list still does not fill the screen`,
      );
    return;
  }
  const followUps = [];
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (url.pathname !== list.path) return;
    const follows =
      list.paging === "offset"
        ? url.searchParams.get("offset") === String(list.firstPage)
        : Boolean(url.searchParams.get("cursor"));
    if (follows) followUps.push(url.search);
  };
  page.on("request", onRequest);
  try {
    for (let attempt = 0; attempt < 20 && (await row(list.firstPage).count()) === 0; attempt += 1) {
      await page.evaluate((mobile) => {
        const scope = document.querySelector(
          `[data-testid="data-table-${mobile ? "mobile" : "desktop"}"]`,
        );
        for (let box = scope; box; box = box.parentElement)
          if (/auto|scroll/.test(getComputedStyle(box).overflowY)) box.scrollTop = box.scrollHeight;
        window.scrollTo(0, document.documentElement.scrollHeight);
      }, !desktop);
      await page.waitForTimeout(150);
    }
  } finally {
    page.off("request", onRequest);
  }
  if (followUps.length === 0)
    throw new Error(`${label}: scrolling to the end asked the engine for no next page`);
  if ((await row(list.firstPage).count()) === 0)
    throw new Error(
      `${label}: row ${list.firstPage + 1} never appeared after scrolling to the end`,
    );
}

async function assertAuditActionChip(page, label) {
  if (!(await page.locator('[data-testid="audit-action-filter"]').isVisible()))
    throw new Error(`${label}: the verbs the link narrowed to are not shown as a chip`);
}

async function assertRunDetail(page, label, language) {
  const facts = page.locator('[data-testid="run-detail-summary"]');
  if (!(await facts.isVisible()))
    throw new Error(`${label} opened no run sheet — the address rendered the bare list`);
  const titleLink = page.locator('[data-testid="run-detail-workflow-link"]');
  await titleLink.waitFor();
  const titleHref = await titleLink.getAttribute("href");
  if (titleHref !== `/cockpit/workflows/${runWorkflowId}`)
    throw new Error(`${label} run title leads to ${titleHref}, not to its workflow`);
  const outcome = page.locator('[data-testid="run-detail-outcome"]');
  await outcome.waitFor();
  const sentence = (await outcome.innerText()).trim();
  const expected =
    language === "de"
      ? "Abgebrochen bei Schritt „write_products“ – Ursache: Anmeldung abgelehnt. Zuvor abgeschlossen: 2 von 3 Schritten."
      : "Stopped at step “write_products” — cause: Sign-in rejected. Completed before that: 2 of 3 steps.";
  if (sentence !== expected)
    throw new Error(`${label} states the outcome as ${JSON.stringify(sentence)}`);
  const failure = page.locator('[data-testid="run-detail-error"]');
  if (!(await failure.isVisible()))
    throw new Error(`${label} hides the error of a run whose last step failed`);
  const errorCount = await page
    .locator('[data-testid="run-detail"]')
    .evaluate(
      (sheet, needle) =>
        [...sheet.querySelectorAll("pre")].filter((node) =>
          (node.textContent ?? "").includes(needle),
        ).length,
      "outside the folder boundary its step declares",
    );
  if (errorCount !== 1)
    throw new Error(`${label} shows the run's error ${errorCount} times, not once`);
  const remedy = page.locator('[data-testid="run-detail-cause-remedy"]');
  await remedy.waitFor();
  const remedyHref = await remedy.getAttribute("href");
  if (remedyHref !== `/cockpit/connectors/${runConnectorId}`)
    throw new Error(`${label} remedy leads to ${remedyHref}, not to the connector to sign in to`);
  const remedyText = (await remedy.innerText()).trim();
  if (remedyText !== (language === "de" ? "Neu anmelden" : "Sign in again"))
    throw new Error(`${label} remedy reads ${JSON.stringify(remedyText)}`);
  const audit = await page.locator('[data-testid="run-detail-audit"]').getAttribute("href");
  if (!audit?.startsWith("/cockpit/audit?resource_type=execution&resource_id="))
    throw new Error(`${label} offers no way into the audit trail (${audit})`);
  const toggle = page.locator('[data-testid="run-detail-payload-toggle"]');
  await toggle.waitFor();
  if (await page.locator('[data-testid="run-detail-result"]').isVisible())
    throw new Error(`${label} opens the payload drawer by itself`);
  const toggleText = (await toggle.innerText()).trim();
  if (toggleText === (language === "de" ? "Ergebnis" : "Result"))
    throw new Error(`${label} labels an earlier step's output as the failed run's result`);
  await toggle.click();
  const result = page.locator('[data-testid="run-detail-result"]');
  await result.waitFor();
  const shown = (await result.innerText()).trim();
  const body = shown.split("\n").slice(1).join("\n").trim();
  if (body === "null" || body === "undefined")
    throw new Error(
      `${label} prints '${body}' as the run's result — a step that produced nothing has no result section`,
    );
  const rerunOf = new URL(page.url()).searchParams.get("run");
  let reruns = 0;
  const countRerun = (request) => {
    if (request.method() === "POST" && request.url().includes("/rerun")) reruns += 1;
  };
  page.on("request", countRerun);
  try {
    await page.locator('[data-testid="run-rerun-open"]').click();
    for (let attempt = 0; attempt < 40 && reruns === 0; attempt += 1) await page.waitForTimeout(50);
    if (await page.getByRole("alertdialog").count())
      throw new Error(`${label} asks again before running again; the dummy starts the run`);
  } finally {
    page.off("request", countRerun);
  }
  if (reruns !== 1) throw new Error(`${label} one click on rerun sent ${reruns} runs`);
  await page
    .waitForURL((url) => url.searchParams.get("run") !== rerunOf, { timeout: 2_000 })
    .catch(() => undefined);
  if (new URL(page.url()).searchParams.get("run") !== rerunOf) {
    await page.goBack();
    await page.waitForURL((url) => url.searchParams.get("run") === rerunOf);
  }
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
  await result.waitFor({ state: "hidden" });
}

async function assertWorkflowDetail(page, label, language) {
  if (await page.locator('[data-testid="workflow-health-badge"]').count())
    throw new Error(`${label}: a badge beside the title repeats the strip`);
  const strip = page.locator('[data-testid="workflow-automation"]');
  await strip.waitFor();
  await page.locator('[data-testid="workflow-automation-state"]').waitFor();
  const stripActions = await strip
    .locator(
      '[data-testid="workflow-automation-action"], [data-testid="workflow-automation-recheck"], [data-testid="workflow-automation-failed-retry"]',
    )
    .count();
  if (stripActions > 1)
    throw new Error(`${label}: the status strip offers ${stripActions} actions, not one`);
  const stripText = await strip.innerText();
  if (stripText.includes("consecutive"))
    throw new Error(`${label}: the strip passes the engine's wording off as its own`);
  const failing = (await strip.getAttribute("data-strip")) === "failing";
  if (failing) {
    const expected = language === "de" ? "Ursache: Anmeldung abgelehnt" : "cause: Sign-in rejected";
    if (!stripText.includes(expected))
      throw new Error(`${label} states the workflow's cause as ${JSON.stringify(stripText)}`);
    if (!(await page.locator('[data-testid="workflow-automation-action"]').isVisible()))
      throw new Error(`${label} shows red with no way to the cause`);
  }
  const tabs = await page
    .locator('[data-testid="workflow-tabs-list"] [role="tab"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
  const expectedTabs = ["verwenden", "verlauf", "aufbau", "freigaben"].map(
    (tab) => `workflow-tabs-tab-${tab}`,
  );
  if (JSON.stringify(tabs) !== JSON.stringify(expectedTabs))
    throw new Error(`${label}: the tabs are ${JSON.stringify(tabs)}`);
  if (!(await page.locator('[data-testid="workflow-invocation"]').isVisible()))
    throw new Error(`${label}: "Verwenden" does not open on the call`);
  if (await page.locator('[data-testid="workflow-io"]').isVisible())
    throw new Error(`${label}: input and output stand open instead of folded`);
  if (
    await page
      .locator(
        '[data-testid="workflow-tab-dag"], [data-family-slot="detail-context"], [data-testid="agent-panel"]',
      )
      .count()
  )
    throw new Error(`${label} still carries the old tabs, the governance row or the agent panel`);
  const opened = async (tab, marker) => {
    await page.locator(`[data-testid="workflow-tabs-tab-${tab}"]`).click();
    await page.locator(marker).filter({ visible: true }).first().waitFor({ state: "visible" });
    if (new URL(page.url()).searchParams.get("tab") !== tab)
      throw new Error(`${label}: the tab "${tab}" is not in the address`);
  };
  await opened(
    "verlauf",
    '[data-testid="workflow-runs-row-0"], [data-testid="workflow-runs-mobile-row-0"]',
  );
  let runLink = page.locator('[data-testid="workflow-runs-row-link-0"]');
  if (!(await runLink.isVisible().catch(() => false)))
    runLink = page.locator('[data-testid="workflow-runs-mobile-row-link-0"]');
  const runHref = await runLink.getAttribute("href");
  if (!runHref?.startsWith(`/cockpit/workflows/${uuid}?`) || !runHref.includes("run="))
    throw new Error(`${label}: a run leads to ${runHref}, not to its sheet on this page`);
  await opened("aufbau", '[data-testid="workflow-steps"]');
  if (!(await page.locator('[data-testid="workflow-technical"]').isVisible()))
    throw new Error(`${label}: "Technische Angaben" is missing from "Aufbau"`);
  await opened("freigaben", '[data-testid="workflow-approvals-summary"]');
  if (await page.locator('[data-testid="authority-headline"]').count())
    throw new Error(`${label} shows an earlier approval before anyone asked for it`);
  const history = page.locator('[data-testid="workflow-former-grants-toggle"]');
  await history.click();
  let first = page.locator('[data-testid="workflow-former-approvals-row-link-0"]');
  if (!(await first.isVisible().catch(() => false)))
    first = page.locator('[data-testid="workflow-former-approvals-mobile-row-link-0"]');
  await first.click();
  const headline = page.locator('[data-testid="authority-headline"]');
  await headline.waitFor();
  const headlineText = await headline.innerText();
  for (const expectedPart of language === "de"
    ? ["Produktion", "gültig bis", "bis zu 24 Läufe"]
    : ["Production", "valid until", "up to 24 runs"])
    if (!headlineText.includes(expectedPart))
      throw new Error(
        `${label} authority headline ${JSON.stringify(headlineText)} lacks ${expectedPart}`,
      );
  const headlineTitle = await headline.locator("[title]").first().getAttribute("title");
  if (headlineTitle !== hostileAuthority.id)
    throw new Error(`${label} authority id is not kept on the headline's title`);
  await page.locator('[data-testid="authority-sheet-close"]').click();
  await page.locator('[data-testid="authority-sheet"]').waitFor({ state: "hidden" });
  await page.locator('[data-testid="workflow-tabs-tab-verwenden"]').click();
  await page.locator('[data-testid="workflow-invocation"]').waitFor({ state: "visible" });
}

async function assertFirstSendIsNeverLost(browser) {
  const typed = "Bitte erstelle eine MCP-Verbindung zu meinem Dienst.";
  const awaiting = {
    ...conversation,
    id: "awaiting-form",
    title: "Wartet auf ein Formular",
    status: "awaiting_input",
    outcome: "awaiting_you",
    created_at: new Date(Date.now() - 30_000).toISOString(),
    updated_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
  };
  const run = async (label, handlePost, check) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "de-DE",
    });
    await context.addInitScript(() => localStorage.setItem("sk-cockpit-locale", "de"));
    const page = await context.newPage();
    const opened = [];
    let releaseList;
    const listHeld = new Promise((resolve) => {
      releaseList = resolve;
    });
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/v1/conversations" && request.method() === "GET") {
        await listHeld;
        const items = [awaiting, ...conversations.filter((entry) => entry.id !== uuid)];
        return json(route, { items, total: items.length });
      }
      if (path === "/v1/conversations" && request.method() === "POST") return handlePost(route);
      const detail = /^\/v1\/conversations\/([^/]+)$/.exec(path);
      if (detail && request.method() === "GET") opened.push(detail[1]);
      if (detail?.[1] === "created-quota")
        return json(route, {
          conversation: { ...conversation, id: "created-quota", title: null, surface: "web" },
          owner: { id: uuid, kind: "user", name: "operator@example.com" },
          created_resources: [],
          messages: [
            {
              id: "m1",
              role: "user",
              parts: [{ type: "text", text: typed }],
              model: null,
              created_at: new Date().toISOString(),
            },
          ],
          tool_calls: [],
          draft: { session: { permission_mode: "auto" } },
          last_turn_error: {
            code: "llm_provider_limited",
            kind: "quota_exhausted",
            retry_at: "2026-10-01T00:00:00.000Z",
            message: "You have reached your specified API usage limits.",
            at: new Date().toISOString(),
          },
          resume_summary: {
            active_target: { kind: "none", name: "none", slug: null, id: null, environment: null },
            stage: "onboarding",
            next_action: "",
            one_sentence: "",
            pending_approval: null,
          },
        });
      return mockApi(route);
    });
    await stand.visit(page, "chat/new", { waitUntil: "commit" });
    const field = page.locator('[data-testid="chat-composer-input"]');
    await field.waitFor({ state: "visible" });
    await field.fill(typed);
    await field.press("Enter");
    setTimeout(() => releaseList(), 300);
    await page.locator('[data-testid="chat-error"]').waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(500);
    try {
      await check(page, field, opened);
    } catch (error) {
      throw new Error(`first send (${label}): ${error.message}`, { cause: error });
    } finally {
      await context.close();
    }
  };

  await run(
    "refused before the engine saw it",
    (route) => route.abort("connectionrefused"),
    async (page, field, opened) => {
      if (opened.includes("awaiting-form"))
        throw new Error("the recovery opened a conversation this send did not create");
      if (!new URL(page.url()).pathname.endsWith("/chat/new"))
        throw new Error(`the page moved to ${page.url()}`);
      if ((await field.inputValue()) !== typed)
        throw new Error(`the composer holds ${JSON.stringify(await field.inputValue())}`);
    },
  );

  await run(
    "refused by the provider's usage limit",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `event: conversation_started\ndata: ${JSON.stringify({
            conversation: { ...conversation, id: "created-quota", title: null },
          })}\n\n` +
          `event: error\ndata: ${JSON.stringify({
            code: "llm_provider_limited",
            message:
              "You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.",
            details: { kind: "quota_exhausted", retry_at: "2026-10-01T00:00:00.000Z" },
          })}\n\n`,
      }),
    async (page, field) => {
      if (!new URL(page.url()).pathname.endsWith("/chat/created-quota"))
        throw new Error(`the page is on ${page.url()}, not on the conversation the send opened`);
      const transcript = await page.locator('[data-testid="chat-transcript"]').innerText();
      if (!transcript.includes(typed)) throw new Error("the request is not in the transcript");
      if ((await field.inputValue()) !== "")
        throw new Error("the request stands in the transcript AND the composer");
      const cause = await page.locator('[data-testid="chat-error-cause"]').innerText();
      if (!cause.includes("Nutzungslimit beim KI-Anbieter") || !cause.includes("2026"))
        throw new Error(`the cause reads ${JSON.stringify(cause)}`);
    },
  );
}

async function assertChat(page, label) {
  await assertChatLayout(page, label, { openList: true });
  const layout = await page.evaluate(() => {
    const rect = (testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!(element instanceof HTMLElement)) throw new Error(`${testId} missing`);
      return element.getBoundingClientRect().toJSON();
    };
    const scrollbar = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`${selector} missing`);
      const style = getComputedStyle(element);
      return { gutter: style.scrollbarGutter, width: style.scrollbarWidth };
    };
    return {
      transcript: rect("chat-transcript"),
      composerArea: rect("chat-composer-area"),
      composer: rect("chat-composer"),
      composerSubmit: rect("chat-composer-submit"),
      main: rect("chat-main"),
      headerColumn: document
        .querySelector('[data-testid="chat-header-column"] > div')
        ?.getBoundingClientRect()
        .toJSON(),
      tools: rect("chat-composer-tools"),
      attach: rect("chat-attach"),
      transcriptColumn: document
        .querySelector('[data-slot="message-scroller-content"]')
        ?.getBoundingClientRect()
        .toJSON(),
      scrollbars: {
        header: scrollbar('[data-testid="chat-header-column"]'),
        transcript: scrollbar('[data-slot="message-scroller-viewport"]'),
        composer: scrollbar('[data-testid="chat-composer-area"]'),
      },
      inputStyle: (() => {
        const input = document.querySelector('[data-testid="chat-composer-input"]');
        if (!(input instanceof HTMLElement)) throw new Error("chat-composer-input missing");
        const style = getComputedStyle(input);
        return {
          paddingLeft: Number.parseFloat(style.paddingLeft),
          paddingTop: Number.parseFloat(style.paddingTop),
          lineHeight: Number.parseFloat(style.lineHeight),
        };
      })(),
    };
  });
  if (layout.transcript.height < 120) throw new Error(`${label} transcript collapsed`);
  if (layout.transcript.bottom > layout.composerArea.top + 1)
    throw new Error(`${label} transcript overlaps composer`);
  if (layout.composerArea.bottom > layout.main.bottom + 1)
    throw new Error(`${label} composer is outside Chat`);
  if (layout.transcript.width < layout.main.width - 4)
    throw new Error(`${label} transcript does not span the conversation column`);
  if (layout.tools.top < layout.composer.top + 40)
    throw new Error(`${label} the composer's toolbar does not stand under its field`);
  if (
    Math.abs(layout.composerSubmit.width - 32) > 1 ||
    Math.abs(layout.composerSubmit.height - 32) > 1
  )
    throw new Error(`${label} composer submit control is not 32px square`);
  const submitRightInset = layout.composer.right - layout.composerSubmit.right;
  const submitBottomInset = layout.composer.bottom - layout.composerSubmit.bottom;
  if (Math.abs(submitRightInset - 8) > 1 || Math.abs(submitBottomInset - 8) > 1)
    throw new Error(`${label} composer submit control is not inset by 8px`);
  if (Math.abs(layout.attach.left - layout.composer.left - 8) > 1)
    throw new Error(`${label} the attach control does not open the toolbar on the left`);
  if (
    Math.abs(layout.inputStyle.paddingLeft - 8) > 1 ||
    Math.abs(layout.inputStyle.lineHeight - 24) > 1
  )
    throw new Error(`${label} composer input spacing is not 8px with 24px leading`);
  if (!layout.headerColumn || !layout.transcriptColumn)
    throw new Error(`${label} shared chat columns are missing`);
  for (const [area, scrollbar] of Object.entries(layout.scrollbars)) {
    if (scrollbar.gutter !== "stable both-edges" || scrollbar.width !== "thin")
      throw new Error(`${label} ${area} scrollbar style is ${JSON.stringify(scrollbar)}`);
  }
  for (const column of [layout.headerColumn, layout.transcriptColumn]) {
    if (
      Math.abs(column.left - layout.composer.left) > 2 ||
      Math.abs(column.right - layout.composer.right) > 2
    )
      throw new Error(
        `${label} header, transcript, and composer columns do not align: ` +
          `header=${layout.headerColumn.left}/${layout.headerColumn.right}, ` +
          `transcript=${layout.transcriptColumn.left}/${layout.transcriptColumn.right}, ` +
          `composer=${layout.composer.left}/${layout.composer.right}`,
      );
  }
  const composerInput = page.locator('[data-testid="chat-composer-input"]');
  const oneLine = (await page.locator('[data-testid="chat-composer"]').boundingBox())?.height ?? 0;
  await composerInput.fill("first line\nsecond line\nthird line\nfourth line");
  const multiline = await page.evaluate(() => {
    const rect = (testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!(element instanceof HTMLElement)) throw new Error(`${testId} missing`);
      return element.getBoundingClientRect().toJSON();
    };
    return { composer: rect("chat-composer"), submit: rect("chat-composer-submit") };
  });
  if (multiline.composer.height <= oneLine)
    throw new Error(`${label} multiline composer did not grow`);
  if (Math.abs(multiline.composer.bottom - multiline.submit.bottom - 8) > 1)
    throw new Error(`${label} multiline submit control is not bottom-aligned`);
  await composerInput.fill("");
  await page.locator('[data-testid="chat-attach-input"]').setInputFiles({
    name: "notizen.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Notizen\n\nZwei Punkte für den Wochenbericht."),
  });
  const chip = page.locator('[data-testid="chat-attachment-0"]');
  await chip.waitFor({ state: "visible" });
  const chipBox = await chip.boundingBox();
  const fieldBox = await composerInput.boundingBox();
  if (!chipBox || !fieldBox || chipBox.y >= fieldBox.y)
    throw new Error(`${label} the attached file does not stand above the field`);
  await page.locator('[data-testid="chat-attachment-0-open"]').click();
  const preview = page.locator('[data-testid="chat-attachment-preview-body"]');
  await preview.waitFor({ state: "visible" });
  await preview
    .getByText("Zwei Punkte")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => {
      throw new Error(`${label} the attachment preview does not show the file`);
    });
  await page.locator('[data-testid="chat-attachment-preview-close"]').click();
  await preview.waitFor({ state: "hidden" });
  await page.locator('[data-testid="chat-attachment-0-remove"]').click();
  await chip.waitFor({ state: "detached" });
  const assistantMetadata = await page
    .locator('[data-testid="chat-message-1-metadata"]')
    .textContent();
  if (!assistantMetadata.includes("provider/model-v1"))
    throw new Error(`${label} assistant metadata is ${JSON.stringify(assistantMetadata)}`);
  const identifiers = await page.evaluate(() => {
    const ID = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
    const messages = [...document.querySelectorAll('[data-cockpit-ui="chat-message"]')];
    const inCode = messages.some((message) =>
      [...message.querySelectorAll("pre, code")].some((element) =>
        (element.textContent ?? "").includes(ID),
      ),
    );
    const inProse = messages.some((message) => {
      const clone = message.cloneNode(true);
      for (const element of [...clone.querySelectorAll("pre, code")]) element.remove();
      return (clone.textContent ?? "").includes(ID);
    });
    return { inCode, inProse };
  });
  if (!identifiers.inCode) throw new Error(`${label} rewrote an identifier inside a payload`);
  if (identifiers.inProse) throw new Error(`${label} prints an identifier in prose`);
  await openConversationList(page);
  const listText = await page.locator('[data-testid="conversation-item-0"]').innerText();
  if (listText.includes('{"tool"')) throw new Error(`${label} exposes a raw tool payload`);
  await closeConversationList(page);
  const assistantWidths = await page
    .locator('[data-testid^="chat-message-"][data-testid$="-content"]')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
  if (assistantWidths.some((width) => width > layout.main.width - 24))
    throw new Error(`${label} message content reaches outside its readable column`);
}

async function openConversationList(page) {
  const list = page.locator('[data-testid="conversation-list"]');
  if (!(await list.isVisible())) {
    await page.locator('[data-testid="conversation-list-trigger"]').click();
    await list.waitFor({ state: "visible" });
  }
}

async function closeConversationList(page) {
  const trigger = page.locator('[data-testid="conversation-list-trigger"]');
  if (!(await trigger.isVisible())) return;
  if ((await trigger.getAttribute("aria-expanded")) !== "true") return;
  await trigger.click();
  await page.locator('[data-testid="conversation-list"]').waitFor({ state: "hidden" });
}

async function assertHeadingAlignment(page, label, route = null, wide = false) {
  const view = route === null ? null : patternMigratedView(route);
  if (view !== null) await assertPatternLayout(page, label, view, wide);
  const measured = await page.evaluate(() => {
    const heading = document.querySelector('[data-testid="page-content"] h1');
    if (!heading) return null;
    const trigger = heading.parentElement?.querySelector('[data-testid="sidebar-trigger"]');
    const lead = trigger instanceof HTMLElement ? trigger : heading;
    const scope = '[data-testid="page-content"]';
    const body = document.querySelector(
      [
        '[data-testid$="-context"]',
        "article",
        '[data-slot="card"]',
        '[data-slot="table-container"]',
        "section",
        "p",
      ]
        .map((selector) => `${scope} ${selector}`)
        .join(", "),
    );
    const h = heading.getBoundingClientRect();
    const gap =
      trigger instanceof HTMLElement
        ? Math.round(h.left - trigger.getBoundingClientRect().right)
        : null;
    if (!body) return { offset: null, gap };
    const a = lead.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    if (b.width === 0 || b.top < h.bottom) return { offset: null, gap };
    return { offset: Math.round(b.left - a.left), gap };
  });
  if (measured === null) return;
  if (measured.gap !== null && (measured.gap < 0 || measured.gap > 16))
    throw new Error(`${label} sets its heading ${measured.gap}px away from the sidebar toggle`);
  if (measured.offset !== null && Math.abs(measured.offset) > 2) {
    throw new Error(`${label} indents its content ${measured.offset}px against its own title row`);
  }
}

const SHEET_WIDTHS = { default: 576, wide: 1024 };

async function assertPatternLayout(page, label, view, wide) {
  const sheet = isSheetView(view);
  const shape = await page.evaluate(
    ({ sheet, widths }) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
          return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      const clean = (value) => (value ?? "").replace(/\s+/g, " ").trim();
      const content = document.querySelector('[data-testid="page-content"]');
      const sheets = [...document.querySelectorAll("[data-sheet-size]")]
        .filter(visible)
        .map((element) => ({
          size: element.getAttribute("data-sheet-size"),
          width: Math.round(element.getBoundingClientRect().width),
          cap: widths[element.getAttribute("data-sheet-size") ?? ""] ?? null,
        }));
      if (sheet) return { sheets, sheetOnly: true };
      const inPage = (selector) =>
        content
          ? [...content.querySelectorAll(selector)].filter(
              (element) => visible(element) && !element.closest('[role="dialog"]'),
            )
          : [];
      const h1s = inPage("h1");
      const h1 = h1s[0];
      const title = clean(h1?.textContent);
      const tab = inPage(
        '[role="tab"][aria-selected="true"], [data-slot="page-tabs"] [aria-current="page"]',
      )[0];
      const tabLabel = clean(tab?.textContent);
      const repeats = inPage('h2, h3, h4, h5, h6, [data-slot="page-back"]')
        .map((element) => clean(element.textContent))
        .filter((text) => text && (text === title || (tabLabel && text === tabLabel)));
      const edges = [
        '[data-slot="page-back"]',
        '[data-testid="page-title-row"]',
        '[data-slot="status-strip"]',
        '[role="tablist"], [data-slot="page-tabs"]',
        '[data-slot="summary-line"]',
        '[data-slot="table-container"]',
      ]
        .map((selector) => [selector, inPage(selector)[0]])
        .filter(([, element]) => element)
        .map(([selector, element]) => [selector, Math.round(element.getBoundingClientRect().left)]);
      const actions = inPage('[data-slot="page-actions"]')[0];
      const centre = (element) => {
        const box = element.getBoundingClientRect();
        return box.top + box.height / 2;
      };
      const filled = [
        ...document.querySelectorAll('button[data-variant="default"], a[data-variant="default"]'),
      ].filter(
        (element) =>
          visible(element) &&
          !element.closest('[role="dialog"], [role="alertdialog"], [data-sheet-size]'),
      );
      return {
        sheetOnly: false,
        sheets,
        h1Count: h1s.length,
        repeats,
        edges,
        actionOffset:
          h1 && actions && actions.children.length > 0
            ? Math.round(centre(actions) - centre(h1))
            : null,
        filled: filled.map(
          (element) => clean(element.textContent) || element.getAttribute("data-testid"),
        ),
      };
    },
    { sheet, widths: SHEET_WIDTHS },
  );
  for (const open of shape.sheets) {
    if (open.cap === null)
      throw new Error(
        `${label}: a sheet has the size "${open.size}" — only default and wide exist`,
      );
    if (open.width > open.cap + 1)
      throw new Error(
        `${label}: a ${open.size} sheet is ${open.width}px wide, not at most ${open.cap}px`,
      );
  }
  if (sheet && shape.sheets.length !== 1)
    throw new Error(`${label}: ${shape.sheets.length} run sheets are open, not one`);
  if (shape.sheetOnly) return;
  if (shape.h1Count !== 1)
    throw new Error(`${label}: ${shape.h1Count} h1 elements on the page, not exactly one`);
  if (shape.repeats.length > 0)
    throw new Error(
      `${label}: a heading repeats the title or the open tab — ${JSON.stringify(shape.repeats)}`,
    );
  const lefts = shape.edges.map(([, left]) => left);
  if (lefts.length > 1 && Math.max(...lefts) - Math.min(...lefts) > 2)
    throw new Error(
      `${label}: the page's blocks start at different x — ${JSON.stringify(shape.edges)}`,
    );
  if (wide && shape.actionOffset !== null && Math.abs(shape.actionOffset) > 2)
    throw new Error(
      `${label}: the page actions sit ${shape.actionOffset}px off the title's centre`,
    );
  if (shape.filled.length > 1)
    throw new Error(
      `${label}: ${shape.filled.length} filled buttons — ${JSON.stringify(shape.filled)}`,
    );
}

async function assertTables(page, label) {
  const unsafeOverflows = await page
    .locator('[data-slot="table-container"]')
    .evaluateAll((elements) =>
      elements
        .map((element, index) => ({
          index,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowX: window.getComputedStyle(element).overflowX,
        }))
        .filter(
          (entry) =>
            entry.scrollWidth > entry.clientWidth + 1 &&
            entry.overflowX !== "auto" &&
            entry.overflowX !== "scroll",
        ),
    );
  if (unsafeOverflows.length) throw new Error(`${label} has uncontained table overflow`);
}

async function assertAuthProviderSettings(page, label) {
  const cards = page.locator('[data-testid^="settings-auth-provider-"]').filter({
    has: page.locator('input[data-testid$="-label"]'),
  });
  if ((await cards.count()) !== 2) {
    throw new Error(`${label} does not render both configured authentication provider cards`);
  }
  const callback = await page.locator('[data-testid="settings-auth-providers"] code').innerText();
  if (callback !== "https://subkit.example.com/v1/identity/login/callback") {
    throw new Error(`${label} renders the wrong OIDC callback URL: ${callback}`);
  }
  for (const testId of [
    "settings-auth-provider-1-issuer-url",
    "settings-auth-provider-1-client-id",
    "settings-auth-provider-1-scopes",
    "settings-auth-provider-1-tenant-slug",
  ]) {
    if ((await page.locator(`[data-testid="${testId}"]`).count()) !== 1) {
      throw new Error(`${label} misses ${testId}`);
    }
  }
  if ((await page.locator('[data-testid*="client-secret"]').count()) !== 0) {
    throw new Error(`${label} exposes a client-secret control for a public PKCE provider`);
  }
}

async function assertBlankLists(page, label) {
  const hits = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((element) => element.children.length === 0 && element.closest("pre, code") === null)
      .map((element) => (element.textContent ?? "").trim())
      .filter((text) => /,\s*,/.test(text) || /:\s*,/.test(text) || /,\s*$/.test(text)),
  );
  const found = [...new Set(hits)];
  if (found.length)
    throw new Error(
      `${label} renders a list of blank values: ${found.map((t) => `"${t.slice(0, 90)}"`).join(", ")}`,
    );
}

async function assertInteractiveSelectors(page, label) {
  const missing = await page
    .locator('button, input, textarea, a[href], [role="menuitem"], [role="menuitemradio"]')
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0;
        if (!visible || element.hasAttribute("data-testid")) return [];
        if (element.closest('[data-slot="copy-field"][data-testid]')) return [];
        return [
          `${element.tagName.toLowerCase()}[${element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 32) || "unlabelled"}] ${element.outerHTML.slice(0, 180)}`,
        ];
      }),
    );
  if (missing.length) throw new Error(`${label} has interactives without data-testid: ${missing}`);
}

let framesWritten = 0;
const written = new Map();

let outputReady = false;
async function prepareOutput() {
  if (outputReady) return;
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  outputReady = true;
}

const writtenPaths = new Map();

function claimFrame(path, label) {
  const earlier = writtenPaths.get(path);
  if (earlier !== undefined)
    throw new Error(
      `Frame "${label}" would overwrite "${earlier}" at ${path}. Two photographs under one name leave one file and two counts, and the end-of-run tally can only say the numbers disagree.`,
    );
  writtenPaths.set(path, label);
}

async function shoot(page, label, options) {
  await prepareOutput();
  const path = resolve(outputDir, stand.frameName(page, label));
  claimFrame(path, label);
  await page.screenshot({ animations: "disabled", ...options, path });
  framesWritten += 1;
  written.set(label, path);
}

async function shootSheet(page, label, options) {
  await prepareOutput();
  const path = resolve(outputDir, stand.sheetName(label));
  claimFrame(path, label);
  await page.screenshot({ animations: "disabled", ...options, path });
  framesWritten += 1;
  written.set(label, path);
}

const stand = standAt({
  baseUrl,
  refuse: (sentence, options) => new Error(`Cockpit visual sweep NOT TAKEN — ${sentence}`, options),
  hint: process.env.COCKPIT_BASE_URL
    ? "COCKPIT_BASE_URL names this port; build the cockpit and run a preview on it, or unset it and let the sweep serve its own build."
    : "The sweep started this preview itself over assets/cockpit — a foreign answer here means the port was taken between the probe and the bind.",
});

assertAuditFixtureActionsAreReal();

const browser = await chromium.launch({ headless: true });
const errors = [];
const locales = [
  { name: "de", browser: "de-DE" },
  { name: "en", browser: "en-US" },
];
const variants = locales
  .flatMap((locale) =>
    ["light", "dark"].map((theme) => ({
      ...locale,
      theme,
      artifact: `${locale.name}-${theme}`,
    })),
  )
  .filter((variant) => sweepList("COCKPIT_SWEEP_VARIANTS")?.includes(variant.artifact) ?? true);
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "wide", width: 1990, height: 1090 },
  { name: "mobile", width: 390, height: 844 },
].filter((viewport) => sweepList("COCKPIT_SWEEP_VIEWPORTS")?.includes(viewport.name) ?? true);

for (const locale of variants) {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      locale: locale.browser,
    });
    await context.addInitScript(
      ({ language, theme }) => {
        localStorage.setItem("sk-cockpit-locale", language);
        localStorage.setItem("sk-cockpit-theme", theme);
      },
      { language: locale.name, theme: locale.theme },
    );
    await context.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = "::-webkit-scrollbar{width:15px;height:15px}";
        document.head.append(style);
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => {
      const message = `${locale.artifact}/${viewport.name}: ${error.message}`;
      errors.push(message);
      console.error(message);
    });
    page.on("console", (message) => {
      if (message.type() === "error")
        console.error(`${locale.artifact}/${viewport.name}: ${message.text()}`);
    });
    await page.route("**/v1/**", mockApi);
    const headingLeft = new Map();
    for (const route of sweptRoutes) {
      const artifactRoute = artifactRouteName(route);
      await stand.visit(page, route);
      try {
        await page.locator(markerFor(route)).waitFor({ state: "visible" });
      } catch (error) {
        const body = await page
          .locator("body")
          .innerText()
          .catch(() => "body unavailable");
        throw new Error(
          `${locale.artifact}/${viewport.name}/${route} did not mount: ${body.slice(0, 1000)}`,
          { cause: error },
        );
      }
      await page
        .locator('[data-testid="data-table-retry"]')
        .waitFor({ state: "hidden" })
        .catch(() => {});
      for (const errorSelector of [
        '[data-testid="data-table-retry"]',
        '[data-testid="attention-error"]',
      ]) {
        if (
          await page
            .locator(errorSelector)
            .isVisible()
            .catch(() => false)
        )
          throw new Error(`${locale.artifact}/${viewport.name}/${route} displays a resource error`);
      }
      const text = await page.locator("body").innerText();
      await assertNoVisibleUuids(
        page.locator("body"),
        `${locale.artifact}/${viewport.name}/${route}`,
      );
      if ((await page.locator("html").getAttribute("lang")) !== locale.name)
        throw new Error(`${locale.artifact}/${viewport.name}/${route} uses the wrong locale`);
      if (!documentThemeMatches(await page.locator("html").getAttribute("class"), locale.theme))
        throw new Error(`${locale.artifact}/${viewport.name}/${route} uses the wrong theme`);
      await assertViewport(page, `${locale.artifact}/${viewport.name}/${route}`);
      await assertTables(page, `${locale.artifact}/${viewport.name}/${route}`);
      await assertHeadingAlignment(
        page,
        `${locale.artifact}/${viewport.name}/${route}`,
        route,
        viewport.width >= 1024,
      );
      const migrated = patternMigratedView(route);
      if (migrated !== null)
        await assertSingleTriggers(page, `${locale.artifact}/${viewport.name}/${route}`, {
          root: patternViewRoot(migrated),
          ...(migrated === "chat" ? { content: TRANSCRIPT.content } : {}),
        });
      await assertInteractiveSelectors(page, `${locale.artifact}/${viewport.name}/${route}`);
      await assertBlankLists(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route === "")
        await assertOverviewHostile(
          page,
          `${locale.artifact}/${viewport.name}/overview`,
          locale.name,
        );
      if (route.startsWith("connectors?health="))
        await assertUnhealthyConnectorsOnly(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route === "usage")
        await assertUsageOrigins(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route === "settings?tab=benachrichtigungen")
        await assertNotificationRules(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route.startsWith("audit?") && route.includes("action="))
        await assertAuditActionChip(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route === "chat") await assertChat(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (
        route === "usage" &&
        (await page.locator('[data-family-kpi-id], [data-testid="operations-bar"]').count()) > 0
      )
        throw new Error(
          `${locale.artifact}/${viewport.name}/usage: the operating figures stand here a second time`,
        );
      if (
        route === "workflows" &&
        ((await page.getByTestId("workflow-health-engine-wording").count()) > 0 ||
          /Wortlaut der Engine|Wording from the engine/.test(text))
      )
        throw new Error(
          `${locale.artifact}/${viewport.name}/workflows: a list row repeats the engine's wording`,
        );
      if (route === "?runs=all")
        await assertOpenOnce(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (/^\?run=.+/.test(route))
        await assertRunDetail(page, `${locale.artifact}/${viewport.name}/${route}`, locale.name);
      if (/^workflows\/.+/.test(route))
        await assertWorkflowDetail(
          page,
          `${locale.artifact}/${viewport.name}/${route}`,
          locale.name,
        );
      if (route === "settings?section=auth")
        await assertAuthProviderSettings(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route === "access") {
        const landed = new URL(page.url());
        if (landed.pathname !== "/cockpit/people" || landed.searchParams.get("section") !== "roles")
          throw new Error(
            `${locale.artifact}/${viewport.name}/access lands on ${landed.pathname}${landed.search}, not the roles of /people`,
          );
        const localizedRoles =
          locale.name === "de"
            ? ["Metrik-Abruf", "Portalnutzer", "Kann Prometheus-Metriken", "Portal-Zugriffstoken"]
            : [
                "Metrics scraper",
                "Portal token user",
                "Can read Prometheus metrics",
                "portal access tokens",
              ];
        for (const expected of localizedRoles) {
          if (!text.includes(expected)) {
            throw new Error(
              `${locale.artifact}/${viewport.name}/${route} misses localized built-in role text: ${expected}`,
            );
          }
        }
      }
      if (route === "" || route === "workflows" || route === "usage")
        headingLeft.set(
          route,
          await page.evaluate(() =>
            Math.round(
              document.querySelector('[data-testid="page-content"] h1')?.getBoundingClientRect()
                .left ?? -1,
            ),
          ),
        );
      await shoot(page, `${locale.artifact}-${viewport.name}-${artifactRoute}`, {
        fullPage: false,
      });
      if (route === "")
        await assertReviewCloseLeavesNoTrail(page, `${locale.artifact}/${viewport.name}/overview`);
      if (route in ENDLESS_LISTS)
        await assertEndlessList(page, `${locale.artifact}/${viewport.name}/${route}`, route);
    }
    if (!focused && new Set(headingLeft.values()).size !== 1)
      throw new Error(
        `${locale.artifact}/${viewport.name}: page titles start at different x — ${JSON.stringify(Object.fromEntries(headingLeft))}`,
      );
    if (standOn(verifyOverviewCalm))
      await verifyOverviewCalm(
        page,
        `${locale.artifact}/${viewport.name}/overview-calm`,
        locale.name,
        () => shoot(page, `${locale.artifact}-${viewport.name}-overview-calm`, { fullPage: false }),
      );
    if (viewport.name === "desktop")
      if (standOn(verifyInstallationPages))
        await verifyInstallationPages(
          page,
          stand,
          locale.name,
          (state) =>
            shoot(page, `${locale.artifact}-${viewport.name}-installation-${state}`, {
              fullPage: false,
            }),
          {
            settingsSections: SETTINGS_SECTION_COUNT,
            viewport,
            settingRows: ENGINE_SETTINGS.map((item) => ({
              path: item.path,
              scope: item.meta.scope,
              source: item.meta.source,
              description: item.meta.description ?? null,
            })),
          },
        );
    if (standOn(verifyApiAccess))
      await verifyApiAccess(page, stand, locale.name, {
        realClients: REAL_OAUTH_CLIENTS,
        deadClients: OAUTH_CLIENTS.filter(
          (item) => !item.disabled_at && item.live_connections === 0,
        ).length,
        disabledClients: OAUTH_CLIENTS.filter((item) => item.disabled_at).length,
        activeKeys: API_KEYS.filter((item) => !item.revoked_at).length,
        revokedKeys: API_KEYS.filter((item) => item.revoked_at).length,
        grantsToRenew: CONNECTIONS.filter((item) =>
          ["expiring", "expired", "unreadable"].includes(item.state),
        ).length,
      });
    if (standOn(verifyScheduleHolds))
      await verifyScheduleHolds(page, stand, uuid, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-schedule-held-${state}`, {
          fullPage: false,
        }),
      );
    if (standOn(verifyHookHolds))
      await verifyHookHolds(page, stand, uuid, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-hook-held-${state}`, { fullPage: false }),
      );
    if (standOn(verifyChatApprovals))
      await verifyChatApprovals(page, stand, conversation, locale.name, async (state) => {
        await assertChatLayout(page, `${locale.artifact}/${viewport.name}/chat-approval-${state}`);
        await shoot(page, `${locale.artifact}-${viewport.name}-chat-approval-${state}`, {
          fullPage: false,
        });
      });
    if (standOn(verifyChatDecidedApproval))
      await verifyChatDecidedApproval(page, stand, conversation, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-chat-approval-${state}`, {
          fullPage: false,
        }),
      );
    if (standOn(verifyChatChoices))
      await verifyChatChoices(page, stand, conversation, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-chat-choice-${state}`, {
          fullPage: false,
        }),
      );
    if (standOn(verifyChatReplies))
      await verifyChatReplies(page, stand, conversation, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-chat-reply-${state}`, { fullPage: false }),
      );
    if (standOn(verifyChatReauth)) await verifyChatReauth(page, stand, conversation);
    if (viewport.name === "desktop")
      if (standOn(verifyLoadFailures))
        await verifyLoadFailures(page, stand, conversation, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-load-failed-${state}`, {
            fullPage: false,
          }),
        );
    if (standOn(verifyChatOAuth)) await verifyChatOAuth(page, stand, conversation, locale.name);
    if (standOn(verifyChatActivation))
      await verifyChatActivation(page, stand, conversation, locale.name);
    if (standOn(verifyChatActivity))
      await verifyChatActivity(page, stand, conversation, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-chat-activity-${state}`, {
          fullPage: false,
        }),
      );
    if (standOn(verifyConnectorDetail))
      await verifyConnectorDetail(page, stand, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: true }),
      );
    if (standOn(verifyCreateConnector))
      await verifyCreateConnector(page, stand, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
      );
    if (standOn(verifyRunDialog))
      await verifyRunDialog(page, stand, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
      );
    if (standOn(verifyDetailAction))
      await verifyDetailAction(page, stand, uuid, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
      );
    if (standOn(verifyWorkflowPreview)) await verifyWorkflowPreview(page, stand, uuid, locale.name);
    if (standOn(verifyWorkflowPage))
      await verifyWorkflowPage(page, stand, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
      );
    if (standOn(verifyWorkflowAuthorities))
      await verifyWorkflowAuthorities(page, stand, uuid, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-workflow-authority-${state}`, {
          fullPage: false,
        }),
      );
    if (standOn(verifyGrantDialog))
      await verifyGrantDialog(page, stand, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-grant-dialog-${state}`, {
          fullPage: false,
        }),
      );
    if (standOn(verifyChatReviewCard))
      await verifyChatReviewCard(page, stand, conversation, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-chat-review-card-${state}`, {
          fullPage: false,
        }),
      );
    if (standOn(verifyGateDiagnosis))
      await verifyGateDiagnosis(page, stand, uuid, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-gate-diagnosis-${state}`, {
          fullPage: false,
        }),
      );
    if (standOn(verifyDecisionLifecycle))
      await verifyDecisionLifecycle(page, stand, uuid, locale.name, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-decisions-${state}`, { fullPage: false }),
      );
    if (viewport.name === "desktop" && !focused) {
      for (const resource of ["workflows", "connectors", "knowledge", "skills"]) {
        await stand.visit(page, `${resource}/${uuid}`);
        await page.locator(`[data-testid="detail-${resource}"]`).waitFor({ state: "visible" });
        await assertViewport(page, `${locale.artifact}/desktop/${resource}-detail`);
        await assertTables(page, `${locale.artifact}/desktop/${resource}-detail`);
        await assertInteractiveSelectors(page, `${locale.artifact}/desktop/${resource}-detail`);
        await assertBlankLists(page, `${locale.artifact}/desktop/${resource}-detail`);
        await shoot(page, `${locale.artifact}-desktop-${resource}-detail`, {
          fullPage: false,
        });
      }
      {
        const where = `${locale.artifact}/desktop/skill-proposal`;
        await stand.visit(page, "skills");
        await page.locator('[data-testid="catalog-skills"]').waitFor({ state: "visible" });
        const listed = await page.locator('[data-testid="catalog-skills"]').innerText();
        for (const advisory of ["capabilities", "Recurring failure"])
          if (listed.includes(advisory))
            throw new Error(`${where}: advisory candidate "${advisory}" listed as a proposal`);
        await page.locator('[data-testid="skills-row-link-0"]').click();
        const sheet = page.locator('[data-testid="skill-proposal"]');
        await sheet.waitFor({ state: "visible" });
        for (const part of ["skill-proposal-preview", "skill-proposal-facts"])
          await sheet.locator(`[data-testid="${part}"]`).waitFor({ state: "visible" });
        for (const verb of ["skill-proposal-accept", "skill-proposal-reject"])
          if ((await sheet.locator(`[data-testid="${verb}"]`).count()) !== 1)
            throw new Error(`${where}: expected exactly one ${verb}`);
        await page.waitForTimeout(300);
        await assertInteractiveSelectors(page, where);
        await shoot(page, `${locale.artifact}-desktop-skill-proposal`, { fullPage: false });
        await sheet.locator('[data-testid="skill-proposal-reject"]').click();
        await page
          .locator('[data-testid="skill-proposal-reject-confirm"]')
          .waitFor({ state: "visible" });
        await shoot(page, `${locale.artifact}-desktop-skill-proposal-reject`, { fullPage: false });
        await page.keyboard.press("Escape");
        await page
          .locator('[data-testid="skill-proposal-reject-confirm"]')
          .waitFor({ state: "hidden" });
        await page.keyboard.press("Escape");
        await sheet.waitFor({ state: "hidden" });
      }
      {
        const where = `${locale.artifact}/desktop/workflow-drafting-context`;
        await stand.visit(page, `workflows/${uuid}?tab=aufbau`);
        const section = page.locator('[data-testid="workflow-drafting-context"]');
        await section.waitFor({ state: "visible" });
        await section.locator('[data-testid="workflow-drafting-context-toggle"]').click();
        const notes = section.locator('[data-testid="workflow-drafting-context-notes"]');
        await notes.waitFor({ state: "visible" });
        const shown = await notes.innerText();
        for (const note of ["capabilities", "Recurring failure"])
          if (!shown.includes(note)) throw new Error(`${where}: the note "${note}" is missing`);
        if (shown.includes("Umbenannte Antwortfelder"))
          throw new Error(`${where}: a proposal is listed as drafting context`);
        if (shown.includes(uuid)) throw new Error(`${where}: a note shows a raw identifier`);
        if (await section.getByRole("button", { name: /annehmen|adopt|ablehnen|reject/i }).count())
          throw new Error(`${where}: drafting context offers a decision`);
        await notes.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await assertInteractiveSelectors(page, where);
        await shoot(page, `${locale.artifact}-desktop-workflow-drafting-context`, {
          fullPage: false,
        });
      }
      let expandedCards = 0;
      for (const [review, positions] of [
        [`workflow:${uuid}`, [0, 1]],
        ["skills", [0]],
      ]) {
        await stand.visit(page, `?review=${review}`);
        await page.locator('[data-testid="attention-review-body"]').waitFor({ state: "visible" });
        for (const position of positions) {
          const toggle = page.locator(`[data-testid="review-decision-${position}-toggle"]`);
          if (!(await toggle.count())) continue;
          await toggle.first().scrollIntoViewIfNeeded();
          await toggle.first().click();
          await page
            .locator(`[data-testid="review-decision-${position}-detail"]`)
            .waitFor({ state: "visible", timeout: 10_000 });
          await page.waitForTimeout(300);
          await shoot(
            page,
            `${locale.artifact}-desktop-review-${review.split(":")[0]}-${position}-expanded`,
            { fullPage: false },
          );
          expandedCards += 1;
        }
      }
      if (expandedCards === 0) {
        throw new Error(`${locale.artifact}: no decision card exposed an expand toggle`);
      }

      await stand.visit(page, "audit?scope=decisions");
      await page.locator('[data-testid="resource-audit"]').waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await shoot(page, `${locale.artifact}-desktop-audit-decisions`, {
        fullPage: false,
      });

      await stand.visit(page, "chat");
      await openConversationList(page);
      await page.locator('[data-testid="conversation-item-0"]').waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await shoot(page, `${locale.artifact}-desktop-chat-list`, {
        fullPage: false,
      });
      await page.locator('[data-testid="conversation-toggle-hidden"]').click();
      await page.locator('[data-testid="conversation-hidden-empty"]').waitFor({ state: "visible" });
      await shoot(page, `${locale.artifact}-desktop-chat-hidden`, {
        fullPage: false,
      });
      await page.locator('[data-testid="conversation-toggle-hidden"]').click();
      await closeConversationList(page);
      await page.locator('[data-testid="conversation-new"]').click();
      await page.locator('[data-testid="chat-empty"]').waitFor({ state: "visible" });
      if ((await page.getByTestId("chat-summary").count()) !== 0)
        throw new Error(`${locale.artifact}: a new conversation carries a line under its title`);
      const newTitle = locale.name === "de" ? "Neue Unterhaltung" : "New conversation";
      if ((await page.getByTestId("chat-title").innerText()).trim() !== newTitle)
        throw new Error(`${locale.artifact}: a new conversation is not titled "${newTitle}"`);
      const modePicker = page.locator('[data-testid="chat-permission-select"]');
      const autoName = locale.name === "de" ? "Autonom" : "Autonomous";
      const askName = locale.name === "de" ? "Fragt vorher" : "Asks first";
      const defaultMode = locale.name === "de" ? "Systemstandard" : "system default";
      const pillText = async () => ((await modePicker.textContent()) ?? "").trim();
      if ((await pillText()) !== autoName)
        throw new Error(
          `${locale.artifact}: the mode pill reads ${JSON.stringify(await pillText())}, not "${autoName}"`,
        );
      if (
        await page
          .getByTestId("chat-mode-gates")
          .isVisible()
          .catch(() => false)
      )
        throw new Error(`${locale.artifact}: the gate matrix stands permanently in the header`);
      const gatesFor = async () => {
        await page.getByTestId("chat-mode-explain").click();
        const gates = page.getByTestId("chat-mode-gates");
        await gates.waitFor({ state: "visible" });
        const text = await gates.innerText();
        await page.keyboard.press("Escape");
        await gates.waitFor({ state: "hidden" });
        return text;
      };
      const autoGates = await gatesFor();
      await modePicker.click();
      const optionCount = await page.getByRole("option").count();
      if (optionCount !== 3)
        throw new Error(`${locale.artifact}: the mode picker offers ${optionCount} modes, not 3`);
      const defaultOption = page.getByRole("option", { name: autoName, exact: true });
      if (!(await defaultOption.innerText()).includes(defaultMode))
        throw new Error(`${locale.artifact}: the open list does not mark the system default`);
      const described = await page
        .locator('[role="option"] [data-slot="select-item-description"]')
        .count();
      if (described !== 3)
        throw new Error(`${locale.artifact}: ${described} of 3 modes explain themselves`);
      await page.getByRole("option", { name: askName, exact: true }).click();
      if ((await pillText()) !== askName)
        throw new Error(`${locale.artifact}: explicit conservative mode is not selectable`);
      if ((await gatesFor()) === autoGates)
        throw new Error(`${locale.artifact}: "ask" reads the same gates as the default mode`);
      await stand.visit(page, "chat/new");
      await page.locator('[data-testid="chat-empty"]').waitFor({ state: "visible" });
      if ((await pillText()) !== autoName)
        throw new Error(`${locale.artifact}: new chat retains an unintended override`);
      await page.waitForTimeout(300);
      await shoot(page, `${locale.artifact}-desktop-chat-new`, {
        fullPage: false,
      });
      await openConversationList(page);
      await page.locator('[data-testid="conversation-item-0"]').click();
      await page.getByTestId("chat-usage-tokens").waitFor({ state: "visible" });
      if ((await page.getByTestId("chat-permission-select").count()) !== 0)
        throw new Error(`${locale.artifact}: a running conversation offers to change its mode`);
      if (!(await page.getByTestId("chat-permission-mode").innerText()).includes(autoName))
        throw new Error(
          `${locale.artifact}: the running conversation's mode pill is not "${autoName}"`,
        );
      if ((await gatesFor()).length === 0)
        throw new Error(`${locale.artifact}: the running conversation's matrix is empty`);
      const tokensPill = (await page.getByTestId("chat-usage-tokens").innerText()).trim();
      if (tokensPill !== (locale.name === "de" ? "48.210 Chat-Tokens" : "48,210 chat tokens"))
        throw new Error(`${locale.artifact}: the tokens pill reads ${JSON.stringify(tokensPill)}`);
      const costText = (await page.getByTestId("chat-usage-cost").innerText()).trim();
      if (!costText.startsWith(locale.name === "de" ? "mind." : "at least"))
        throw new Error(
          `${locale.artifact}: a partly priced cost reads ${JSON.stringify(costText)}`,
        );
      const budgetLink = page.getByTestId("chat-budget");
      if ((await budgetLink.getAttribute("data-budget")) !== "critical")
        throw new Error(`${locale.artifact}: the month at 95 % shows no critical allowance pill`);
      if (!(await budgetLink.getAttribute("href"))?.endsWith("/usage"))
        throw new Error(`${locale.artifact}: the allowance pill does not lead to Nutzung`);
      if ((await page.getByTestId("chat-origin").count()) !== 0)
        throw new Error(`${locale.artifact}: the origin line still stands in the header`);
      const tool = page.locator('[data-testid="chat-message-3-tool-0"]');
      await tool.scrollIntoViewIfNeeded();
      await page.locator('[data-testid="chat-message-3-tool-0-toggle"]').click();
      await shoot(page, `${locale.artifact}-desktop-chat-tool`, {
        fullPage: false,
      });
      await page.locator('[data-testid="chat-context-toggle"]').click();
      await page.locator('[data-testid="chat-context"]').waitFor({ state: "visible" });
      await page.locator('[data-testid="chat-context-reference-0"]').waitFor({ state: "visible" });
      if ((await page.locator('[data-testid="chat-context-reference-0"] a').count()) !== 0)
        throw new Error(`${locale.artifact}: unresolved chat reference is still linked`);
      const resolvedReference = page.locator('[data-testid="chat-context-reference-1"] a');
      if ((await resolvedReference.count()) !== 1)
        throw new Error(`${locale.artifact}: resolved chat reference is not linked`);
      if (!(await resolvedReference.getAttribute("href"))?.includes(`/workflows/${uuid}`))
        throw new Error(`${locale.artifact}: resolved chat reference links to the wrong record`);
      await page.waitForTimeout(300);
      await shoot(page, `${locale.artifact}-desktop-chat-context`, {
        fullPage: false,
      });
      await page.locator('[data-testid="chat-context-close"]').click();
      await page.locator('[data-testid="chat-context"]').waitFor({ state: "hidden" });
      await page.locator('[data-testid="chat-composer-input"]').fill("Prüfe @mon");
      await page.locator('[data-testid="chat-mention-popover"]').waitFor({ state: "visible" });
      await page.locator('[data-testid="chat-mention-item-0"]').waitFor({ state: "visible" });
      const pickerHit = await page.evaluate(() => {
        const row = document.querySelector('[data-testid="chat-mention-item-0"]');
        if (!row) return false;
        const r = row.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return Boolean(hit && row.contains(hit));
      });
      if (!pickerHit)
        throw new Error(`${locale.artifact}: the @-picker is in the page but covered or clipped`);
      await shoot(page, `${locale.artifact}-desktop-chat-mention`, {
        fullPage: false,
      });
      await page.keyboard.press("Escape");
      const composerField = page.locator('[data-testid="chat-composer-input"]');
      await composerField.fill("");
      await composerField.pressSequentially("Zeig @rep");
      await page.locator('[data-testid="chat-mention-item-0"]').waitFor({ state: "visible" });
      const firstPick = (await page.getByTestId("chat-mention-item-0").innerText()).replace(
        /\s+/g,
        " ",
      );
      if (!/kategorie\/reporting · 21 workflows/i.test(firstPick))
        throw new Error(
          `${locale.artifact}: the picker's first entry is ${JSON.stringify(firstPick)}, not the reporting category`,
        );
      await page.keyboard.press("Enter");
      if ((await composerField.inputValue()) !== "Zeig @kategorie/reporting ")
        throw new Error(
          `${locale.artifact}: picking a category wrote ${JSON.stringify(await composerField.inputValue())}`,
        );
      await composerField.fill("");
      const chips = page.locator('[data-testid="chat-message-2-text-0-mentions"]');
      await chips.scrollIntoViewIfNeeded();
      await page
        .locator('[data-testid="chat-message-2-text-0-chip-1"]')
        .waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await shoot(page, `${locale.artifact}-desktop-chat-mention-chips`, {
        fullPage: false,
      });
      await page
        .locator('[data-testid="chat-composer-input"]')
        .fill("Prüfe den Workflow, ohne ihn auszuführen.");
      await page.locator('[data-testid="chat-composer-submit"]').click();
      await page
        .locator('[data-testid="chat-error"]')
        .waitFor({ state: "hidden" })
        .catch(() => {});
      await shoot(page, `${locale.artifact}-desktop-chat-interaction`, {
        fullPage: false,
      });
      await stand.visit(page, "workflows");
      await page.locator('[data-testid="sidebar-trigger"]').hover();
      await page.locator('[data-slot="tooltip-content"]').waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await shoot(page, `${locale.artifact}-desktop-tooltip`, {
        fullPage: false,
      });
      await page.locator('[data-testid="account-menu-trigger"]').click();
      await page.locator('[data-testid="account-menu"]').waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await shoot(page, `${locale.artifact}-desktop-account`, {
        fullPage: false,
      });
      await page.locator('[data-testid="account-language-menu"]').hover();
      await page.locator('[data-testid="account-language-content"]').waitFor({ state: "visible" });
      await shoot(page, `${locale.artifact}-desktop-account-language`, {
        fullPage: false,
      });
      await page.keyboard.press("Escape");
      await page.locator('[data-testid="account-language-content"]').waitFor({ state: "hidden" });
      await page.keyboard.press("Escape");
      await page.locator('[data-testid="account-menu"]').waitFor({ state: "hidden" });
      await page.locator('[data-testid="account-menu-trigger"]').click();
      await page.locator('[data-testid="account-menu"]').waitFor({ state: "visible" });
      await page.locator('[data-testid="account-theme-menu"]').hover();
      await page.locator('[data-testid="account-theme-content"]').waitFor({ state: "visible" });
      await shoot(page, `${locale.artifact}-desktop-account-theme`, {
        fullPage: false,
      });
    }
    await context.close();
  }
}

for (const locale of focused ? [] : variants) {
  for (const viewport of ["desktop", "mobile"].filter((name) =>
    viewports.some((swept) => swept.name === name),
  )) {
    const contact = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    });
    const cards = await Promise.all(
      sweptRoutes.map(async (route) => {
        const artifactRoute = artifactRouteName(route);
        const frame = written.get(`${locale.artifact}-${viewport}-${artifactRoute}`);
        if (frame === undefined)
          throw new Error(
            `no frame ${locale.artifact}/${viewport}/${artifactRoute} to build a sheet from`,
          );
        const bytes = await readFile(frame);
        const source = `data:image/png;base64,${bytes.toString("base64")}`;
        return `<figure><img src="${source}" alt=""><figcaption>${artifactRoute}</figcaption></figure>`;
      }),
    );
    await contact.setContent(
      `<style>
      * { box-sizing: border-box }
      body { margin: 0; padding: 16px; background: #e2e8f0; font: 14px system-ui }
      main { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px }
      figure { margin: 0; overflow: hidden; border-radius: 8px; background: white; box-shadow: 0 1px 3px #64748b }
      img { display: block; width: 100%; aspect-ratio: ${viewport === "desktop" ? "1.44" : "0.462"}; object-fit: cover; object-position: top }
      figcaption { padding: 8px; font-weight: 600 }
    </style><main>${cards.join("")}</main>`,
      { waitUntil: "load" },
    );
    await shootSheet(contact, `${locale.artifact}-${viewport}-contact-sheet`, {
      fullPage: true,
    });
    await contact.close();
  }
}
const RESPONSIVE_WIDTHS = [390, 768, 1024, 1440, 1920];
const migratedRoutes = sweptRoutes.filter((route) => patternMigratedView(route) !== null);
for (const width of RESPONSIVE_WIDTHS) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    locale: "de-DE",
    reducedMotion: "reduce",
  });
  await context.addInitScript(() => {
    localStorage.setItem("sk-cockpit-locale", "de");
    localStorage.setItem("sk-cockpit-theme", "light");
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`responsive/${width}: ${error.message}`));
  await page.route("**/v1/**", mockApi);
  for (const route of migratedRoutes) {
    await stand.visit(page, route);
    await page.locator(markerFor(route)).waitFor({ state: "visible" });
    await assertNoHorizontalScroll(page, `responsive/${width}/${route}`);
  }
  await context.close();
}

if (standOn(assertFirstSendIsNeverLost)) await assertFirstSendIsNeverLost(browser);
await browser.close();
spawnedPreview?.stop();
if (errors.length) throw new Error(errors.join("; "));
if (framesWritten === 0) await prepareOutput();
const framesOnDisk = (await readdir(outputDir, { recursive: true, withFileTypes: true })).filter(
  (entry) => entry.isFile() && entry.name.endsWith(".png"),
).length;
if (framesOnDisk !== framesWritten)
  throw new Error(
    `Cockpit visual sweep counted ${framesWritten} frames but ${outputDir} holds ${framesOnDisk} ` +
      "PNG files. A screenshot was taken past shoot(), so the number below would not be a " +
      "measurement of this run.",
  );
console.log(
  `Cockpit visual sweep passed: ${framesWritten} screenshots in ${outputDir} ` +
    "(counted at each write and held against the files on disk — not computed from the route table)",
);
