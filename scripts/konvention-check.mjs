import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ALL_ROUTE_PATHS } from "../apps/cockpit/src/app/route-table.ts";
import { CATALOGS, interpolate } from "../apps/cockpit/src/lib/i18n.ts";
// §7 keeps the six products from importing each other's rules; it says nothing
// about this file reading its own repository's. The identity READER lived here
// a second time, and the second copy carried the same defect as the first — it
// answered with the first `content="…"` in the document, prose included. Both
// copies are gone, and so is the ASSERT: there is no separate identity step in
// this file any more. `standAt().visit()` is the only way to a page, and it
// navigates and names in one act, so a stand that changes hands after answering
// once is caught at the next document rather than never. The price is one
// `page.evaluate` per navigation.
import { IDENTITY_META, standAt } from "./lib/cockpit-identity.mjs";

// The family convention (COCKPIT-KONVENTION.md, the version named by
// KONVENTION_VERSION below) is deliberately not enforced by shared code — six
// products copy patterns, they do not import them (§7). What is left is drift,
// so the rules that can be observed on a rendered page are asserted here
// against this repo's own cockpit.
//
// It runs against the built bundle with every /v1 call mocked, so it needs
// neither a database nor a running engine and reports the same verdict on any
// machine. It reports EVERY breach it finds rather than stopping at the first:
// the output is the work list for the next conformity round, and a list that
// truncates itself hides the size of the gap.

/**
 * The convention version this checker is written against. Set BY HAND and held
 * against the header of the copy in this repository by `checkKonventionVersion`.
 *
 * WHY a constant and not the number read out of the document: a checker that
 * reads the version from COCKPIT-KONVENTION.md and then prints it makes the two
 * agree by construction — the sentence asserts nothing. This file climbed from
 * v1.4 to v1.5 by hand, and the places that still said "v1.4" were found by
 * grep. That is exactly the drift a machine should catch: a convention copy that
 * moves on while this checker stays put is a checker measuring against an
 * agreement nobody holds it to any more.
 *
 * The number READ from the file is the label (`konventionVersionImRepo`, printed
 * as "Standard"). Label and assert stand side by side on purpose — one says what
 * was measured against, the other says whether that is still the family's yardstick.
 */
const KONVENTION_VERSION = "1.7";

/** The version the repository copy actually names — the label, never the assert. */
let konventionVersionImRepo = null;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const previewPort = Number(process.env.COCKPIT_PREVIEW_PORT || 4176);
const externalBaseUrl = process.env.COCKPIT_BASE_URL?.replace(/\/$/, "");
const baseUrl = externalBaseUrl || `http://127.0.0.1:${previewPort}`;

// Every route the cockpit can render. The rules about forbidden words and
// unlabelled actions are DOM-wide claims, and a claim checked on two pages is
// not the claim the convention makes.
//
// The list is READ from the ROUTER's table, not typed beside it and not taken
// from the navigation. A typed copy is a second truth about which pages exist
// (§12). And the navigation is the wrong source even though the derivation is
// right: it knows the pages it LINKS to, not the pages that are there. A route
// reachable only by a redirect, a menu or a pasted link would be structurally
// invisible — the check could run forever and never see it. `/approvals`,
// `/chat/new` and `/chat/{id}` are exactly that shape here.
const ROUTES = ALL_ROUTE_PATHS.map((path) => path.replace(/^\//, ""));

/** A parameterised segment needs a record; the fixture's is the one it gets. */
function concreteRoute(route) {
  return route.replace("$conversationId", ID).replace("$resourceId", ID);
}

// How a mounted page is recognised. This is a table about RENDERING, not about
// which routes exist — the two redirects are listed by the page they must land
// on, which is the whole claim a redirect makes.
const MOUNT_MARKERS = {
  "": '[data-testid="overview-page"]',
  approvals: '[data-testid="decisions-page"]',
  decisions: '[data-testid="decisions-page"]',
  chat: '[data-testid="chat-workspace"]',
  "chat/new": '[data-testid="chat-workspace"]',
  "chat/$conversationId": '[data-testid="chat-workspace"]',
  people: '[data-testid="admin-people"]',
  access: '[data-testid="admin-access"]',
  "api-access": '[data-testid="admin-api-access"]',
  connections: '[data-testid="admin-connections"]',
  operations: '[data-testid="admin-operations"]',
  notifications: '[data-testid="admin-notifications"]',
  settings: '[data-testid="admin-settings"]',
  workflows: '[data-testid="catalog-workflows"]',
  connectors: '[data-testid="catalog-connectors"]',
  knowledge: '[data-testid="catalog-knowledge"]',
  skills: '[data-testid="catalog-skills"]',
  files: '[data-testid="catalog-files"]',
  "workflows/$resourceId": '[data-testid="detail-workflows"]',
  "connectors/$resourceId": '[data-testid="detail-connectors"]',
  "knowledge/$resourceId": '[data-testid="detail-knowledge"]',
  "skills/$resourceId": '[data-testid="detail-skills"]',
  "files/$resourceId": '[data-testid="detail-files"]',
};

const NOW = Date.now();
const days = (count) => new Date(NOW - count * 86_400_000).toISOString();
const hours = (count) => new Date(NOW + count * 3_600_000).toISOString();

// Ids never reach the screen (§5), so the fixture uses one shaped like the real
// thing: if the cockpit ever leaks an identifier, the UUID rule must see it.
const ID = "018f4b4a-6d33-7b3a-9c2d-123456789abc";

// The change notes are English on purpose: the engine passes the repair model's
// own text through verbatim, and §5 is about what the CARD does with it — a
// German summary line on top, the English note as the detail underneath.
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

// One conversation still inside its deadline and one past it: the queue has to
// render both the blocking and the lapsed rubric, and §8.3 forbids a deadline
// that passes in silence.
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

/**
 * What the engine says about where a conversation stands.
 *
 * The prose is the engine's own, verbatim: §5 is about what the COCKPIT does
 * with it. The German line is built from `stage` and `active_target`, so the
 * assert below can read the one against the other.
 */
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

// The engine counts more waiting conversations than one page of them delivers.
// Without this the fixture could never tell an exact total from a rendered row
// count, which is precisely the confusion §8.1 is about.
const CONVERSATION_TOTAL = AWAITING_CONVERSATIONS.length + 2;

/**
 * The positions the QUEUE holds — the ones this page can decide.
 *
 * Not the same as QUEUE_TOTAL any more, and that is the point of this round: a
 * waiting conversation is counted and named on its own tile and answered in the
 * conversation, because the queue never had an approve or a reject for it.
 *
 * The line THIS FIXTURE paints reads "35 offen · Korrekturen aus Läufen: 2 ·
 * Skill-Vorschläge: 1 · Unterhaltungen: 32" — the bench's numbers, chosen here,
 * and never a measurement of the product. §8.5b once carried that 32 as one:
 * the mock behind it ignored the status filter, and on PROD the same call
 * answers total=1. What the fixture is for is the rule, which holds at any
 * size: a position with no consequence here is not a decision here.
 */
const DECIDABLE_TOTAL = PATCH_CANDIDATES.length - 1 + SKILL_CANDIDATES.length;

/** The number of distinct decidable positions the queue can actually render. */
const QUEUE_SHOWN = DECIDABLE_TOTAL;

/**
 * What the patch endpoint hands over: the three candidates, one of them twice.
 *
 * A row delivered twice must be one decision on every surface — the badge, the
 * queue and the banner. Shipping the duplicate through the fixture is the only
 * way the dedup key is proven on a rendered page rather than in a unit alone.
 */
const PATCH_ROWS = [...PATCH_CANDIDATES, PATCH_CANDIDATES[0]];

// §6 gives the installation section a notification entry, and §4 forbids
// proving it with an empty page: a rule and a channel are what the populated
// state looks like.
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
  },
];

/**
 * The number every surface must show: the engine's own counts, summed.
 *
 * A workflow that is approved and keeps failing waits on them too — the page
 * lists it in its own section and the badge counts it. It is NOT part of
 * `DECIDABLE_TOTAL`: the queue has no approve or reject for it, it links to the
 * runs that failed. That is the same split this check already draws for waiting
 * conversations, and drawing it is the whole of §8.1.
 */
const QUEUE_TOTAL = DECIDABLE_TOTAL + FAILURE_GROUPS.length;

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

/**
 * What a detail surface asks for, and what the list never had to answer.
 *
 * The sweep used to stop at the top level, so the fixture only ever answered
 * `GET /v1/connectors` and never `GET /v1/connectors/{id}` — the same gap seen
 * from the other side. The record IS the first row of the list the reader just
 * came from, so the two surfaces cannot disagree about the same thing; the
 * extras below are only the fields a detail body reads and a list column does
 * not carry.
 */
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

function overviewMetric(id, value, path, severity = "information") {
  return {
    id,
    value,
    value_state: value === 0 ? "zero" : "observed",
    severity,
    kind: "count",
    drilldown: { path },
  };
}

function operationalOverview(gateOpen) {
  const generatedAt = new Date(NOW).toISOString();
  const blocked = 0;
  const overdue = gateOpen ? 2 : 0;
  // The failure groups have a tile of their own now. They used to be swept into
  // "other decisions" by this arithmetic, which is how the overview came to
  // disagree with the queue it links to while both looked self-consistent.
  const failing = gateOpen ? FAILURE_GROUPS.length : 0;
  const other = gateOpen ? Math.max(DECIDABLE_TOTAL - overdue, 0) : 0;
  return {
    schema_version: "operational-overview.v1",
    contract_version: "2.1",
    product: "subkit",
    generated_at: generatedAt,
    recommended_refresh_seconds: 60,
    snapshot_state: "ready",
    core: {
      blocked: overviewMetric(
        "decisions.blocked",
        blocked,
        "/cockpit/decisions?bucket=blocked",
        blocked > 0 ? "critical" : "healthy",
      ),
      failing: overviewMetric(
        "decisions.failing",
        failing,
        "/cockpit/decisions?bucket=failing",
        failing > 0 ? "urgent" : "healthy",
      ),
      overdue: overviewMetric(
        "decisions.overdue",
        overdue,
        "/cockpit/decisions?bucket=overdue",
        overdue > 0 ? "urgent" : "healthy",
      ),
      other_decisions: overviewMetric("decisions.other", other, "/cockpit/decisions?bucket=other"),
      health: {
        ...overviewMetric("operations.health", 94, "/cockpit/operations", "healthy"),
        kind: "score",
        state: "healthy",
        components: [],
      },
      data_freshness: {
        ...overviewMetric("data.freshness", 18, "/cockpit/operations?focus=data", "healthy"),
        kind: "duration",
        state: "fresh",
        sources: [],
      },
    },
    sections: [
      {
        id: "workflows",
        title: "Workflows",
        visualization: "kpi",
        metrics: [overviewMetric("automation.active_workflows", 14, "/cockpit/workflows")],
        drilldown: { path: "/cockpit/workflows" },
      },
    ],
    audit: { path: "/cockpit/audit", snapshot_generated_at: generatedAt },
  };
}

/**
 * One handler for every /v1 call the cockpit makes.
 *
 * `gateOpen` is the only switch: §8.7 makes two opposite claims about the same
 * page, and the banner rule is only proven when the fixture can also produce
 * the state in which the banner must be absent.
 */
function apiMock(gateOpen, { unknownDecisionKind = false } = {}) {
  return async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const status = url.searchParams.get("status");

    if (path === "/v1/cockpit/bootstrap") return json(route, BOOTSTRAP);
    if (path === "/v1/operator/health-digest") return json(route, healthDigest(gateOpen));
    if (path === "/v1/schedules") return json(route, { schedules: [], total: 0 });
    if (path === "/v1/operational-overview") return json(route, operationalOverview(gateOpen));

    // The three decision sources follow `gateOpen` too: the badge, Zone A and
    // the banner all read them now, so the calm variant has to be able to say
    // "nothing is open" through the same endpoints the busy one uses.
    if (path === "/v1/patch-candidates") {
      const items = gateOpen && status === "proposed" ? PATCH_ROWS : [];
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
        // A state the cockpit used to render in English by construction: only
        // ONE of the engine's seven sentences was ever translated, and only on
        // byte equality. Six were English whatever happened, so the fixture
        // stands in one of the six.
        resume_summary: RESUME_SUMMARY,
      });

    // The detail surfaces the sweep now reaches, answered from the same rows
    // the list page shows.
    for (const listPath of DETAIL_LISTS) {
      if (path === `${listPath}/${ID}`) return json(route, detailRecord(listPath));
    }
    if (path === `/v1/knowledge-sources/${ID}/content`) return json(route, KNOWLEDGE_CONTENT);
    if (path === `/v1/files/${ID}/content`)
      return route.fulfill({
        status: 200,
        contentType: "text/markdown",
        body: FILE_CONTENT,
      });

    if (DETAIL_LISTS.includes(path)) {
      const items = catalogRows(path);
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
      // The decision history the §8.5 link leads to. The engine's `action`
      // filter takes a comma-separated list, so the fixture answers it the same
      // way — a mock that ignored the filter would let a page that never sent
      // one pass. `settings.write` is deliberately not a verb the cockpit has a
      // word for: the honest fallback (the engine's own string) has to be
      // visible in a frame too, or nobody would notice it turning into
      // "Unbekannt".
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

    // Anbindungen: one connection per state word, so every badge the page can
    // render is in the DOM — and the expired one carries its way back (§11).
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
            used_by_connectors: 2,
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
            last_error: "invalid_grant",
            used_by_connectors: 0,
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
            used_by_connectors: 0,
            created_at: days(2),
          },
        ],
      });
    if (path === `/v1/connectors/${ID}/credential`)
      return json(route, {
        mode: "connection",
        environment: "prod",
        connection: { id: ID, name: "wiki" },
        updated_at: days(2),
      });
    // Vorbereitete Änderungen: one waits, so Einstellungen shows the section.
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
                id: "upraft",
                label: "Upraft Auth",
                issuer_url: "https://auth.mikebild.info",
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
            value: "https://subkit.mikebild.info",
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
            effective_role: "admin",
            role_consistent: true,
            status: "active",
            oauth_connections: 2,
          },
          {
            id: "user-2",
            email: "redaktion@example.org",
            role: "member",
            effective_role: "member",
            role_consistent: true,
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
            scopes: ["workflow:read", "workflow:run"],
            created_at: days(30),
            last_used_at: days(1),
            expires_at: null,
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

/** A breach names the paragraph it breaks, the place, and what is actually there. */
function breach(rule, where, actual) {
  violations.push({ rule, where, actual });
}

/**
 * §12 — a surface the sweep could not reach is reported, not skipped.
 *
 * The old sweep stopped at the top level and said nothing about it, so a whole
 * class of pages read as "checked and clean" when it was never looked at. A gap
 * is not a breach — nothing is broken — but it is not silence either: it stands
 * in the output beside the verdict, in the pass case as much as in the fail
 * case, so the size of what is unchecked stays visible.
 */
const gaps = [];

function gap(where, why) {
  gaps.push({ where, why });
}

// Two blind spots hold in EVERY run, so they are registered before the first
// measurement instead of being discovered during one. Both are known and open
// findings, not accidents — and a verdict that stays silent about them reads
// wider than it is.
gap(
  "wordmark in the collapsed rail",
  "only the expanded sidebar is measured — breaking the icon or the name while collapsed passes here",
);
gap(
  "catalogue en",
  "every rule runs against de. The silent class: §2 forbids a STATE, what is measured is the WORD „Unbekannt“ — on en the same state reads „Unknown“ and goes unnoticed. English decision-state vocabulary therefore remains outside this sweep",
);
gap(
  "/decisions · §8.5 completeness of the history",
  "the ONE link and the naming of the four decision verbs in the log are measured; whether the log HOLDS every decision is not — that is the engine's write path, and this check never writes one",
);
gap(
  "/decisions · §8.5b the size of the number itself",
  "the page-wide badge, Zone A and the actionable queue split are measured, the cut is not: this check cannot say whether 35 positions should have been 5. What it can say — that a position with no consequence here is not a decision here — is asserted; the grouping of like corrections into one decision remains open (SK-R1)",
);

/** The detail surfaces the sweep actually reached, named in the verdict. */
const swept = [];

/**
 * §7 — the convention copy in this repository and this checker name the same version.
 *
 * The only rule here that needs neither a browser nor a server, and the only one
 * about the checker itself. §7 makes the copy in each repository the mechanism
 * against drift; a copy that has moved on while the checker still quotes the
 * previous number turns that mechanism into decoration — the run ends with
 * "keine Verstöße gegen v1.4" and reads like a clean bill of health for an
 * agreement that no longer exists in that form.
 */
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
  konventionVersionImRepo = header.match(/^Version (\d+\.\d+)/m)?.[1] ?? null;
  if (konventionVersionImRepo !== KONVENTION_VERSION)
    breach(
      "§7",
      where,
      `version ${konventionVersionImRepo ?? "(no version in the header line)"} — this check is written by hand against v${KONVENTION_VERSION}`,
    );
}

/**
 * §5 / §6 — the role word is one spelling family-wide.
 *
 * "Administration", "ADMINISTRATOR" and "Admin" are three products' worth of
 * drift around the same fact, which is why the convention pins the string
 * rather than the concept.
 */
async function checkRoleLabel(page) {
  const label = await page.locator('[data-testid="account-role"]').innerText();
  if (label.trim() !== "Administrator")
    breach("§5, §6", "/overview · [data-testid=account-role]", label.trim());
}

/**
 * §6 (v1.5) — Wortmarke, Schreibweise des Produktnamens, App-Icon, Browser-Titel.
 *
 * The five assertions below are the five checkpoints §6 asks every product for.
 * Each one exists because the obvious, cheaper version of it passes on a broken
 * console:
 *
 *  1. The name is compared CASE-SENSITIVELY. A case-insensitive `includes`
 *     accepts "SUBKIT" and "subkit", which is precisely the drift the family
 *     agreed to end — the internal capital IS the name.
 *  2. The all-caps guard reads the COMPUTED `text-transform`, not the class
 *     list. A class list check goes green the moment somebody adds `uppercase`
 *     through a variant, a parent rule or the stylesheet, and it cannot see a
 *     `.toUpperCase()` in the code at all — so the rendered text is read too.
 *  3. The icon has to be measurably on the page, not merely in the DOM: a
 *     `display:none` square is an icon nobody has.
 *  4. The browser title is the first thing anybody reads of this product.
 *  5. The favicon link must RESOLVE. Status 200 alone is worthless here: the
 *     cockpit handler answers every unknown path under /cockpit/ with the SPA
 *     shell — 200, text/html — so "/cockpit/cockpit/favicon.svg" reads as a
 *     success and shows an empty tab. Hence content type AND a real decode,
 *     the latter because an SVG with a broken XML comment still ships as
 *     image/svg+xml and still renders nothing as an <img>.
 */
const PRODUCT_NAME = "SubKit";
const BROWSER_TITLE = `${PRODUCT_NAME} Cockpit`;

// The path the cockpit is served under — read from the Vite configuration
// rather than typed here, because a second truth about the base path is exactly
// the bug this check is meant to catch.
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

  // 1 — the canonical spelling, character for character.
  if (!seen.containerText.includes(PRODUCT_NAME))
    breach(
      "§6 (Wortmarke)",
      where,
      `"${seen.containerText.trim().split("\n")[0] ?? ""}" — does not contain "${PRODUCT_NAME}" character for character`,
    );

  // 2 — no all-caps and no all-lowercase, measured on the rendered element.
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

  // 3 — an icon element, visible, beside the name.
  if (!seen.hasIcon) {
    breach("§6 (App-Icon)", where, "no icon element beside the name");
  } else if (!seen.iconVisible) {
    breach("§6 (App-Icon)", where, "the icon element is in the DOM but not visible");
  } else if (seen.hasName && !seen.iconBeforeName) {
    breach("§6 (App-Icon)", where, "the icon does not precede the name");
  }
}

/** §6 — the browser title is exactly „<Produktname> Cockpit". */
async function checkBrowserTitle(page) {
  const title = await page.title();
  if (title !== BROWSER_TITLE)
    breach("§6 (Browser-Titel)", "/overview · <title>", `"${title}" instead of "${BROWSER_TITLE}"`);
}

/**
 * §6 — the favicon link exists AND the file behind it actually arrives.
 *
 * Resolved against the page's own address, so the real base path (/cockpit/) is
 * part of the measurement rather than an assumption about it.
 */
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

  // Resolved against the page's own address, so the base path is measured and
  // not assumed. `/favicon.svg` in the source is correct precisely BECAUSE Vite
  // turns it into `${COCKPIT_BASE}favicon.svg` when it builds; what arrives in
  // the browser is the only thing worth asserting on.
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

/** §6 — the admin navigation group is called "Installation", never "Administration". */
async function checkAdminGroupName(page) {
  const group = page.locator('[data-testid="nav-group-admin"]');
  if ((await group.count()) === 0) {
    breach("§6", "/overview · Sidebar", "no admin nav group present");
    return;
  }
  const label = (await group.first().innerText()).split("\n")[0]?.trim() ?? "";
  if (label !== "Installation") breach("§6", "/overview · nav-group-admin", label);
}

/**
 * §6 — the installation section carries the five entries the family shares.
 *
 * The convention pins the set, not the extras: a product may add its own
 * entries, but a section missing System, Einstellungen, Zugangsdaten,
 * Benachrichtigungen or Audit is a section a person has to learn twice.
 */
const INSTALLATION_ENTRIES = [
  "System",
  "Einstellungen",
  "Zugangsdaten",
  "Benachrichtigungen",
  "Audit",
];

async function checkInstallationEntries(page) {
  const labels = await page.evaluate(() => {
    const group = document.querySelector('[data-testid="nav-group-admin"]');
    if (!group) return null;
    return [...group.querySelectorAll("a[data-testid]")].map((link) => link.innerText.trim());
  });
  if (labels === null) return;
  for (const entry of INSTALLATION_ENTRIES) {
    if (!labels.includes(entry))
      breach("§6", "/overview · nav-group-admin", `entry "${entry}" is missing`);
  }
}

/**
 * §6 / §8.1 — the decisions entry is ungrouped, sits directly under the
 * overview, and carries a live counter.
 *
 * Ungrouped is read off the rendered sidebar rather than off the navigation
 * table: a group that renders a heading above the entry is a group, whatever
 * the data structure calls it.
 */
async function checkDecisionsNavEntry(page) {
  const entry = page.locator('[data-testid="nav-decisions"]');
  if ((await entry.count()) === 0) {
    breach("§6, §8.1", "/overview · Sidebar", 'no nav entry "Entscheidungen"');
    return;
  }
  const label = (await entry.first().innerText()).trim();
  if (label !== "Entscheidungen") breach("§8.1", "/overview · nav-decisions", label);

  const placement = await page.evaluate(() => {
    const decisions = document.querySelector('[data-testid="nav-decisions"]');
    if (!decisions) return null;
    const group = decisions.closest('[data-testid^="nav-group-"]');
    const heading = group?.querySelector(
      '[data-slot="sidebar-group-label"], [data-sidebar="group-label"]',
    );
    const links = [...document.querySelectorAll('[data-testid^="nav-"]')].filter(
      (element) => element.tagName === "A",
    );
    const index = links.indexOf(decisions);
    return {
      groupHeading: heading instanceof HTMLElement ? heading.innerText.trim() : "",
      previous: index > 0 ? links[index - 1].getAttribute("data-testid") : null,
    };
  });
  if (placement?.groupHeading)
    breach(
      "§6, §8.1",
      "/overview · nav-decisions",
      `sits under the group heading "${placement.groupHeading}" instead of ungrouped`,
    );
  if (placement && placement.previous !== "nav-overview")
    breach(
      "§8.1",
      "/overview · nav-decisions",
      `does not sit directly below the overview (preceded by: ${placement.previous})`,
    );

  const badge = page.locator('[data-testid="nav-decisions-count"]');
  if ((await badge.count()) === 0) {
    breach("§8.1", "/overview · nav-decisions", "no counter badge on the entry");
    return null;
  }
  return (await badge.first().innerText()).trim();
}

/** §2 — "Unbekannt" is not a state; an unresolved one says since when and why. */
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

/**
 * §8.7 — the incident banner stands above the tiles and carries exactly one way
 * out, into the decisions page.
 *
 * Both halves matter. A dashboard that reports calm while a gate is open is the
 * breach the paragraph was written for; a banner that appears with nothing open
 * trains people to ignore it.
 */
async function _checkIncidentBanner(page, gateOpen) {
  const banner = page.locator('[data-testid="overview-incident"]');
  const present = (await banner.count()) > 0;
  if (!gateOpen) {
    if (present)
      breach(
        "§8.7",
        "/overview (fixture without an open gate)",
        "banner visible despite all-clear",
      );
    return;
  }
  if (!present) {
    breach("§8.7", "/overview (fixture with an open gate)", "no incident banner in the DOM");
    return;
  }
  const shape = await page.evaluate(() => {
    const alert = document.querySelector('[data-testid="overview-incident"]');
    const tiles = document.querySelector('[data-testid="overview-waiting"]');
    if (!alert || !tiles) return null;
    const before = Boolean(alert.compareDocumentPosition(tiles) & Node.DOCUMENT_POSITION_FOLLOWING);
    const links = [...alert.querySelectorAll("a[href]")].map((link) => link.getAttribute("href"));
    return { before, links };
  });
  if (!shape) {
    breach("§8.7", "/overview", "tiles missing, banner position cannot be determined");
    return;
  }
  if (!shape.before) breach("§8.7", "/overview", "banner sits after the tiles in the DOM");
  if (shape.links.length !== 1)
    breach(
      "§8.7",
      "/overview · overview-incident",
      `${shape.links.length} links instead of exactly one`,
    );
  else if (!shape.links[0].includes("/decisions"))
    breach("§8.7", "/overview · overview-incident", `link points at ${shape.links[0]}`);
  return checkBannerSubset(page);
}

/** Family dashboard v2 — one compact aggregate surface, never a duplicate incident feed. */
async function checkOperationalDashboard(page, expectedDecisionTotal) {
  const result = await page.evaluate(() => {
    const core = document.querySelector('[data-family-slot="operational-core"]');
    const cards = core
      ? [...core.querySelectorAll(":scope > [data-family-kpi-id]")].map((card) => ({
          id: card.getAttribute("data-family-kpi-id"),
          value: Number(card.getAttribute("data-family-kpi-value") ?? 0),
          links: card.querySelectorAll('[data-family-kpi-link="true"]').length,
          linkLabels: card.querySelectorAll('[data-family-kpi-link-label="true"]').length,
          tooltips: card.querySelectorAll('[data-family-kpi-tooltip="true"]').length,
          primary: card.getAttribute("data-family-primary") === "true",
        }))
      : [];
    return {
      cards,
      incidentBanners: document.querySelectorAll('[data-testid="overview-incident"]').length,
      tables: document.querySelectorAll('[data-testid="overview-page"] table').length,
    };
  });
  const expectedOrder = [
    "decisions.blocked",
    "decisions.failing",
    "decisions.overdue",
    "decisions.other",
    "operations.health",
    "data.freshness",
  ];
  const actualOrder = result.cards.map((card) => card.id);
  if (actualOrder.join("|") !== expectedOrder.join("|"))
    breach(
      "§1, §8.1",
      "/cockpit",
      `operational cards are ${actualOrder.join(", ")} instead of ${expectedOrder.join(", ")}`,
    );
  for (const card of result.cards) {
    if (card.links !== 1 || card.linkLabels !== 1 || card.tooltips !== 1)
      breach(
        "§1, §8.1",
        `/cockpit · ${card.id}`,
        `${card.links} card links, ${card.linkLabels} visible link labels, ${card.tooltips} tooltips`,
      );
  }
  const primary = result.cards.filter((card) => card.primary).length;
  if (primary !== 1) breach("§1, §8.1", "/cockpit", `${primary} primary actions instead of one`);
  if (result.incidentBanners > 0)
    breach("§8.7", "/cockpit", "legacy incident banner duplicates the KPI summary");
  if (result.tables > 0)
    breach("§1", "/cockpit", "overview contains a table instead of aggregate KPI cards");
  // Four decision tiles now, not three. The fourth is not a new number: it is
  // the one the third used to absorb — failure groups were counted as "other
  // decisions", so the sum came out right while every part of it was wrong.
  const decisionTotal = result.cards.slice(0, 4).reduce((sum, card) => sum + card.value, 0);
  if (decisionTotal !== expectedDecisionTotal)
    breach(
      "§8.1",
      "/cockpit",
      `decision KPIs total ${decisionTotal}, expected ${expectedDecisionTotal}`,
    );
  return decisionTotal;
}

/**
 * §8.1 / §8.7 — the banner names its subsets, and says of what.
 *
 * The pinned wording changed here on purpose, and it is a correction of the
 * measure rather than a relaxation of it. The earlier regex pinned ONE sentence
 * — "N von M blockieren ihren Workflow" — over a subset that summed the
 * blocking, the lapsed and the merely-old positions. Two of those three claims
 * were false: a lapsed position stopped nothing, and the aged ones sit one
 * click away under a rubric whose own hint reads "Blockiert nichts". The
 * assert therefore pinned a sentence the product could only satisfy by lying.
 *
 * What is pinned now is strictly more: each claim states its own share AND its
 * base (§8.1), and the LABEL of each claim must equal the heading of the rubric
 * it is a share of — which is checked against the rendered queue in
 * checkCounterCoherence. A banner can no longer be worded into agreement with
 * itself while disagreeing with the page it links to.
 */
const BANNER_CLAIM = /^(.+): (mindestens )?(\d+) von (\d+)$/;

async function readBannerClaim(page, testId) {
  return page.evaluate((id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!(element instanceof HTMLElement)) return null;
    return {
      text: element.innerText.trim(),
      count: element.getAttribute("data-subset"),
    };
  }, testId);
}

async function checkBannerSubset(page) {
  const subset = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="incident-decisions-count"]');
    if (!element) return null;
    return {
      count: element.getAttribute("data-subset"),
      total: element.getAttribute("data-subset-total"),
    };
  });
  if (!subset) {
    breach("§8.1", "/overview · overview-incident", "banner names no subset");
    return null;
  }
  const count = Number(subset.count);
  const total = Number(subset.total);
  if (!(count > 0 && count <= total))
    breach(
      "§8.1",
      "/overview · incident-decisions-count",
      `subset ${subset.count} does not fit inside total ${subset.total}`,
    );

  const claims = {};
  let named = 0;
  for (const [name, testId] of [
    ["blocking", "incident-blocking"],
    ["overdue", "incident-overdue"],
  ]) {
    const claim = await readBannerClaim(page, testId);
    if (!claim) continue;
    named += 1;
    const match = BANNER_CLAIM.exec(claim.text);
    if (!match) {
      breach("§8.1", `/overview · ${testId}`, claim.text);
      continue;
    }
    const [, label, , share, base] = match;
    if (Number(share) !== Number(claim.count))
      breach(
        "§8.1",
        `/overview · ${testId}`,
        `sentence says ${share}, the attribute says ${claim.count}`,
      );
    if (Number(base) !== total)
      breach("§8.1", `/overview · ${testId}`, `sentence gives total ${base} instead of ${total}`);
    claims[name] = { label: label.trim(), count: Number(claim.count) };
  }
  if (named === 0)
    breach("§8.7", "/overview · overview-incident", "banner names not a single subset");
  const stated = Object.values(claims).reduce((sum, claim) => sum + claim.count, 0);
  if (stated !== count)
    breach(
      "§8.1",
      "/overview · overview-incident",
      `subset ${count}, but only ${stated} are named`,
    );
  return { total, claims };
}

/** §1 — Zone A's head is the same number the badge carries, or the page lies. */
async function _readZoneACount(page) {
  const value = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="zone-a-decisions-count"]');
    return element instanceof HTMLElement ? element.innerText.trim() : null;
  });
  if (value === null) {
    breach("§1, §8.1", "/overview · overview-waiting", "zone A names no count");
    return null;
  }
  return Number(value);
}

/**
 * §12 / §1 — one truth per fact.
 *
 * The tools page rendered the failure groups and the repair counter a second
 * time, from a second read of the same digest, and reported different numbers
 * than the overview did. A page that restates another page's findings will
 * eventually contradict it, so the restatement is what is asserted against —
 * not the numbers, which is a race nobody wins.
 */
async function checkOperationsIsToolsOnly(page) {
  const echo = await page.evaluate((cause) => {
    return {
      cause: document.body.innerText.includes(cause),
      groups: document.querySelectorAll('[data-testid^="operations-failure-"]').length,
      risks: document.querySelectorAll('[data-testid^="operations-risk-"]').length,
      link: Boolean(document.querySelector('[data-testid="operations-open-overview"]')),
    };
  }, FAILURE_GROUPS[0].cause);
  if (echo.cause) breach("§12", "/operations", "repeats the overview's error-group cause");
  if (echo.groups > 0)
    breach("§12", "/operations", `${echo.groups} error-group rows beside the overview`);
  if (echo.risks > 0) breach("§12", "/operations", `${echo.risks} risk rows beside the overview`);
  if (!echo.link) breach("§12", "/operations", "no way to the findings on the overview");
}

/**
 * §8.2 — positions older than three days stand under "Liegt schon länger".
 *
 * The name is pinned, and pinned once: the rubric used to sit nested inside a
 * section headed "Kann warten" — the product deciding on the reader's behalf
 * what it has no way to know — and a second rubric wearing the same name would
 * make the pinned one unfindable.
 */
const AGED_RUBRIC = "Liegt schon länger";

async function checkAgingRubric(page) {
  const aged = page.locator('[data-testid="decisions-aged"]');
  if ((await aged.count()) === 0) {
    breach("§8.2", "/decisions", "no aging rubric although positions are older than 3 days");
    return;
  }
  const heading = (await aged.first().locator("h1, h2, h3, h4").first().innerText()).trim();
  if (heading !== AGED_RUBRIC) breach("§8.2", "/decisions · decisions-aged", heading);

  const headings = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-testid^="decisions-"] h1, [data-testid^="decisions-"] h2, [data-testid^="decisions-"] h3, [data-testid^="decisions-"] h4',
      ),
    ].map((element) => element.innerText.trim()),
  );
  const wearing = headings.filter((entry) => entry === AGED_RUBRIC).length;
  if (wearing !== 1)
    breach(
      "§8.2",
      "/decisions",
      `${wearing} rubrics are called "${AGED_RUBRIC}" instead of exactly one`,
    );
  for (const forbidden of ["Kann warten"]) {
    if (headings.includes(forbidden))
      breach("§8.2", "/decisions", `rubric "${forbidden}" judges on the reader's behalf`);
  }
}

/**
 * §5 / §8.2 — every rubric of the queue is headed in German, and in these words.
 *
 * `checkBannerAgainstConversations()` reads the banner against the count it is a
 * share of, but both sides take their wording from the same catalog key: flip
 * that key to English and the two still agree, in English, and the check stays
 * green. So the German wording is pinned here as well — once per rubric, and
 * the aged one through the constant that already owns it.
 *
 * A rubric the fixture leaves empty is not rendered, and an unrendered heading
 * proves nothing; that is why a missing section is itself a breach rather than
 * a silent skip.
 *
 * Two rubrics left this table with the waiting conversations: "Abgelaufen" and
 * "Blockiert gerade etwas" describe an elicitation deadline and a suspended
 * agent loop, and neither can be true of a proposed fix or a proposed skill.
 * Pinning them here would have pinned a heading the page can no longer produce
 * — which is not a stricter check, it is a check that measures the fixture.
 * The two words did not disappear from the product: they are the banner's two
 * claims on the overview, read back against the conversation source in
 * checkBannerAgainstConversations().
 */
const RUBRIC_HEADINGS = {
  "decisions-current": "Weitere Entscheidungen",
  "decisions-aged": AGED_RUBRIC,
};

async function checkRubricLanguage(page) {
  const headings = await page.evaluate(
    (ids) =>
      Object.fromEntries(
        ids.map((id) => {
          const heading = document.querySelector(
            `[data-testid="${id}"] h1, [data-testid="${id}"] h2, [data-testid="${id}"] h3, [data-testid="${id}"] h4`,
          );
          return [id, heading instanceof HTMLElement ? heading.innerText.trim() : null];
        }),
      ),
    Object.keys(RUBRIC_HEADINGS),
  );
  for (const [testId, expected] of Object.entries(RUBRIC_HEADINGS)) {
    const actual = headings[testId];
    if (actual === null) {
      breach(
        "§8.2",
        `/decisions · ${testId}`,
        `rubric "${expected}" is missing — its wording stays unmeasured`,
      );
      continue;
    }
    if (actual !== expected)
      breach("§5", `/decisions · ${testId}`, `rubric reads "${actual}" instead of "${expected}"`);
  }
}

/** §8.5a — one filter row, one actionable queue, one exit to history. */
async function checkDecisionAnatomy(page) {
  const shape = await page.evaluate(() => ({
    filters: document.querySelectorAll('[data-family-slot="filters"]').length,
    queue: document.querySelectorAll('[data-family-slot="queue"]').length,
    audit: document.querySelectorAll('[data-family-slot="audit-link"] a').length,
    legacyTiles: document.querySelectorAll('[data-testid^="decisions-tile-"]').length,
  }));
  if (shape.filters !== 1)
    breach("§8.5a", "/decisions", `expected one filter row, found ${shape.filters}`);
  if (shape.queue !== 1) breach("§8.5a", "/decisions", `expected one queue, found ${shape.queue}`);
  if (shape.audit !== 1)
    breach("§8.5", "/decisions", `expected one audit exit, found ${shape.audit}`);
  if (shape.legacyTiles !== 0)
    breach("§8.5a", "/decisions", `found ${shape.legacyTiles} redundant category KPI tiles`);
}

const german = (key, values) => interpolate(CATALOGS.de[key], values);

/**
 * §8.5 — the decisions page shows what waits, and nothing that is over.
 *
 * The rule is new and it is checked IN SEVERAL SHAPES, because one shape is one
 * spelling of the same idea and the next implementation will choose another:
 *
 *   1. no heading anywhere on the page carries a settled word,
 *   2. no rendered position carries a settled `data-state`,
 *   3. no chip, tab or toggle offers to put the queue into a past state,
 *   4. there is no collapsed section whose trigger names one.
 *
 * EVERY collapsible on the page is opened first. This is the load-bearing step
 * and it was found the hard way in a sister repo: Radix does not mount the
 * content of a closed Collapsible, so a rule that reads the DOM as it finds it
 * would have been GREEN on the very console that still had two shelves of
 * decided work under its queue — the content simply was not there to see.
 */
/**
 * THE ALPHABET OF FINISHED WORK — DERIVED, NOT TYPED.
 *
 * The previous version of this rule listed five German words and six state
 * names as literals, connected to nothing. That is weaker than either family
 * version of the same rule, and weaker in the way that does not announce
 * itself: WikiKit's list can shrink when a catalogue key is renamed, and it
 * still reads FROM the catalogue; a typed list cannot shrink because it was
 * never attached — it simply measures a vocabulary the product stopped using,
 * reports nothing, and exits 0.
 *
 * It was measured, not suspected. `Entschieden 128 · Verworfen 12 · Für später
 * erinnert 4 · Abgelaufen 3` placed plainly in a <p> on /decisions passed the
 * built check with exit 0 and no breach: the four shapes below read headings,
 * `article[data-state]` and button/tab/link labels, and a line in a paragraph
 * is none of them — and „Für später erinnert" was not even in the word list.
 *
 * WHAT IS DERIVED, AND WHAT STILL IS NOT. The honest form of the claim, because
 * the previous one — "so both halves now come from somewhere" — was not true of
 * the second half and read as though it were:
 *
 *  - THE STATES come out of the generated engine contract. A decision here is a
 *    patch or skill candidate, and their `status` enums are the product's own
 *    statement of what a candidate can BE. The check is inverted against them:
 *    a position whose `data-state` is not one of the OPEN states is settled —
 *    so a settled state invented tomorrow is caught without anybody adding it
 *    to a list.
 *  - THE WORDS come out of both catalogues, for the keys named below, in both
 *    languages. Rename the key and the run stops; change the word and the new
 *    word is what gets looked for.
 *  - THE REST — `PROSE_WORDS` — is held by nothing, and CAN go stale. That is
 *    drift in the direction of OUT OF DATE rather than SHRUNK: rename such a
 *    word on the surface and this alphabet keeps the dead one and misses the
 *    live one. It cannot make the check blind the way a shrinking list does,
 *    but it can make it look wider than it is.
 *
 * So: the derived half cannot drift in silence; the prose half can. Which is
 * the reason the list below is as short as it can be made — every word that a
 * catalogue key actually spells was moved OUT of it and into the derived half.
 * It was not a theory: „Beantwortet" sat in the prose list while the catalogue
 * key `tool.status.approvalResponded` had „Responded" on en. The alphabet held
 * the dead word and missed the live one, which is the whole class in one entry.
 *
 * WHAT THAT MOVE DID TO THE SIZE OF THE ALPHABET — measured, because the first
 * statement of it was not. `SETTLED_WORDS.size` was 34 before the move and is
 * 34 after it: the move is a SWAP, not a growth. „Answered" — a typed guess —
 * leaves, „Responded" — read from `tool.status.approvalResponded` · en —
 * arrives, and the other 33 words are the same words. The claim "30 -> 34" in
 * the commit that made the move is a number nobody measured; no reading of the
 * two builds produces 30. The readings that do exist, both builds, in order:
 * union of all words 34 -> 34, derived words only 19 -> 25, entries fed in
 * (keys plus typed literals) 25 -> 23, catalogue hits counted with duplicates
 * plus literals 35 -> 37.
 *
 * AND THE DIRECTION IS NOT THE ONE CLAIMED DIRECTLY ABOVE. „Answered" is the
 * one word this move takes OUT of the alphabet, so the prose half did not only
 * enlarge here — it shrank by one, which is the direction the paragraph above
 * says a derived half cannot drift in and an unbound one should not. The word
 * is live on the surface: `decisions.tile.conversationHint` on en reads
 * "Answered in the conversation, not here." A settled word standing beside a
 * figure in that sentence would now go unread. It stays without consequence
 * for ONE reason only, and it is a reason recorded as a gap rather than as
 * coverage: this run measures de alone (see the registered `catalogue en` gap,
 * and "Language: de only" in the report). The day en is measured, this hole is
 * a real one.
 */
const engineOpenApi = JSON.parse(
  readFileSync(
    new URL("../packages/cli-core/src/engine-api/openapi.json", import.meta.url),
    "utf8",
  ),
);

/** What a decision IS, according to the contract the engine publishes. */
const CANDIDATE_SCHEMAS = ["PatchCandidate", "SkillCandidate"];

function candidateStates(schema) {
  const properties = engineOpenApi.components?.schemas?.[schema]?.properties;
  return properties?.status?.enum ?? properties?.state?.enum ?? [];
}

const CANDIDATE_STATES = [...new Set(CANDIDATE_SCHEMAS.flatMap(candidateStates))].sort();

/**
 * The one state a candidate is in while it still waits, plus the card's own
 * word for it. `decision-card.tsx` writes `data-state="open"`; the contract
 * calls the same thing `proposed`. Everything else is over.
 */
const OPEN_STATES = ["open", "proposed"];
const SETTLED_STATES = CANDIDATE_STATES.filter((state) => !OPEN_STATES.includes(state));

/**
 * The catalogue keys this run CLAIMS name a state something is in after it is
 * over. Written out rather than derived, because "which states are past" is a
 * statement about the domain — a list read out of the same file it is compared
 * against would agree by construction. This is the claim; the catalogue is the
 * evidence, and `assertSettledAlphabetIsCurrent` is what stops the two drifting
 * apart in silence.
 */
const SETTLED_STATUS_KEYS = [
  ...SETTLED_STATES.map((state) => `status.${state}`),
  "status.abandoned",
  "status.aborted",
  "status.archived",
  "status.cancelled",
  "status.completed",
  "status.succeeded",
];

/**
 * FINISHED WORK THAT NO STATUS BADGE SPELLS — but a catalogue key does.
 *
 * These words used to sit in `PROSE_WORDS` as literals, on the belief that "no
 * status key carries them". Four keys do, and reading them instead of typing
 * them is what makes this half of the alphabet follow the console: change the
 * word and the new word is what gets looked for, rename the key and the run
 * stops at `assertSettledAlphabetIsCurrent` rather than measuring a vocabulary
 * nobody uses.
 *
 * They are separate from SETTLED_STATUS_KEYS because they are not states: they
 * are a tool outcome, a lapsed deadline and an answered question, and a reader
 * who finds them under a list called "status keys" learns something false.
 */
const SETTLED_PROSE_KEYS = [
  "status.expired",
  "decisions.expired",
  "tool.outcome.done",
  "tool.status.approvalResponded",
];

/**
 * WHAT IS STILL TYPED, and the honest note on it.
 *
 * Family vocabulary for finished work that this console does not currently
 * spell anywhere — so there is no key to read it from and nothing holds it.
 * They enlarge the alphabet and cannot shrink it, which is why they are allowed
 * to stay; but an entry here is a GUESS about wording, not a reading of it, and
 * a guess that the surface later adopts under a different spelling goes quietly
 * out of date. Anything that acquires a catalogue key belongs in the list above,
 * not in this one.
 */
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

/** Every word for finished work this build can put on a screen, and where it came from. */
const SETTLED_WORDS = new Map();
for (const key of [...SETTLED_STATUS_KEYS, ...SETTLED_PROSE_KEYS])
  for (const locale of ["de", "en"]) {
    const label = CATALOGS[locale]?.[key];
    if (!label) continue;
    // ACCUMULATED, not overwritten. `status.aborted` and `status.cancelled` both
    // read „Abgebrochen" on de, and a bare `.set` made the report name whichever
    // key happened to come last — one report, two keys, the wrong source named.
    const seen = SETTLED_WORDS.get(label);
    SETTLED_WORDS.set(
      label,
      seen === undefined ? `${key} · ${locale}` : `${seen}, ${key} · ${locale}`,
    );
  }
for (const [word, why] of PROSE_WORDS) if (!SETTLED_WORDS.has(word)) SETTLED_WORDS.set(word, why);

/**
 * A DRIFTED ALPHABET IS BLIND, NOT CLEAN — so this stops the run with 2 rather
 * than reporting a violation, and it does so BEFORE the preview server and the
 * browser start. "Measured nothing" must never leave as "found nothing".
 *
 * WatchKit has no such guard, and it was measured there: a renamed catalogue
 * key let the same probe run all the way through and exit 0 without a word.
 * WorkKit has one, and it is the reason its list cannot quietly get shorter.
 *
 * One direction only. An extra word costs nothing; a MISSING one is exactly the
 * hole a counter line walks through.
 */
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

/**
 * A settled word STANDING WITH A NUMBER, read off the rendered text.
 *
 * This is the shape the four structural readings below cannot see and the one
 * the counter line used. It is not a word ban: „Abgelaufen" is the correct
 * label on a conversation whose deadline lapsed while it still waits for an
 * answer, and the page's own way out of the present tense is a sentence built
 * from these words. What §8.5 forbids is a COUNT of what is over — so the
 * measure is the word next to a figure.
 *
 * CASE-SENSITIVE and WHOLE WORDS, which is the entire difference between the
 * label „Verworfen 12" and this page's own prose „Was bereits entschieden
 * wurde:". Escaped, because these words come out of a catalogue and a catalogue
 * may one day hold a bracket. The separator deliberately excludes the newline:
 * a badge on one line and an unrelated figure on the next is not a counter.
 */
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

/**
 * Everything that can be opened, opened — EACH TRIGGER PRESSED ONCE, BY IDENTITY.
 *
 * The previous shape walked a Playwright locator by index and would have been
 * the count-based loop ContentKit measured: there, a progress loop that read
 * "how many are still folded" reported "nothing answered a click" across four
 * routes on which every click worked, because opening one panel reveals the
 * next folded thing inside it and the number stood still. Identity in a
 * `WeakSet` answers the question the count cannot: was THIS trigger pressed.
 *
 * TWO KINDS OF TRIGGER ARE EXCLUDED, both measured elsewhere and neither tidy:
 *
 *  - `aria-haspopup` — dialogs and menus. What they open is a portal outside
 *    the page, not folded content, and its overlay then swallows every
 *    following click.
 *  - `role="combobox"` — Radix's `Select` carries `aria-expanded` and NO
 *    `aria-haspopup`, and opens on POINTERDOWN, so a synthetic `click()` does
 *    nothing to it. ContentKit paid 29 hanging triggers per route for that
 *    omission: 510 s instead of 22 s.
 *
 * Bounded, because a trigger that folds itself back is a defect and not a
 * reason to spin. What the bound leaves shut is reported as unread, not as
 * clean: Radix does not mount a closed Collapsible's content, so a rule that
 * read the DOM as it found it would have been green on a console that still had
 * two shelves of decided work under its queue.
 */
const FOLDED =
  '[data-testid="decisions-page"] [aria-expanded="false"]:not([aria-haspopup]):not([role="combobox"])';

async function unfoldDecisions(page) {
  return page.evaluate(async (selector) => {
    const settle = () =>
      new Promise((done) =>
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 0),
      );
    const pressed = new WeakSet();
    for (let step = 0; step < 120; step += 1) {
      for (const details of document.querySelectorAll(
        '[data-testid="decisions-page"] details:not([open])',
      ))
        details.open = true;
      const next = [...document.querySelectorAll(selector)].find(
        (element) => element instanceof HTMLElement && !pressed.has(element),
      );
      if (!next) return 0;
      pressed.add(next);
      next.click();
      // Waited for the STATE to be rendered, not for a fixed delay: React has to
      // commit before the trigger nested inside this panel exists at all.
      await settle();
    }
    return [...document.querySelectorAll(selector)].filter((element) => !pressed.has(element))
      .length;
  }, FOLDED);
}

/**
 * §8.5 — the decisions page shows what waits, and nothing that is over.
 *
 * Checked IN FIVE SHAPES, because one shape is one spelling of the same idea
 * and the next implementation will choose another:
 *
 *   1. no heading anywhere on the page carries a settled word,
 *   2. no rendered position carries a state that is not an open one,
 *   3. no chip, tab or toggle offers to put the queue into a past state,
 *   4. there is no collapsed section whose trigger names one,
 *   5. no settled word stands beside a figure in the rendered text of the page,
 *      in whatever markup — which is the one the other four cannot see.
 */
async function checkNothingSettled(page) {
  const unopened = await unfoldDecisions(page);
  // NOT a gap, and this is the whole point of the distinction. A gap is a blind
  // spot the run KNOWS about and prints beside a verdict that still stands; it
  // does not touch the exit code. Reporting an unopened section as one let §8.5
  // — the rule whose load-bearing step is that every collapsible is opened
  // first — degrade to "not measured" and exit 0 anyway. That is the class this
  // repository has spent the day on: a check that stops measuring and stays
  // green. So it aborts with 2, in the currency the report already has for
  // "this run says nothing".
  if (unopened > 0)
    throw new NichtGemessen(
      `/decisions · §8.5: ${unopened} folded section(s) were never opened — Radix does not mount a ` +
        "closed Collapsible, so what stands inside them was not in the DOM to be read. The rule " +
        "was not measured on this page.",
    );

  const found = await page.evaluate(
    ({ words, openStates }) => {
      const surface = document.querySelector('[data-testid="decisions-page"]');
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
      // The WHOLE page, not the queue container: a counter line put in the page
      // header, the shell or a footer counts just as much. Only runs of spaces
      // are collapsed — the newline has to survive, or a badge on one line and a
      // figure on the next would read as a counter.
      const text =
        document.body instanceof HTMLElement
          ? document.body.innerText.replace(/[^\S\n]+/g, " ")
          : "";
      return { headings, cards, controls, stateless, text };
    },
    { words: [...SETTLED_WORDS.keys()], openStates: OPEN_STATES },
  );
  if (found === null) {
    breach("§8.5", "/decisions", "the page did not mount, nothing about it was measured");
    return;
  }
  for (const heading of found.headings)
    breach("§8.5", "/decisions", `section "${heading}" holds settled work on the decisions page`);
  for (const state of found.cards)
    breach(
      "§8.5",
      "/decisions",
      `a position renders with data-state="${state}" — not one of ${OPEN_STATES.join(", ")}`,
    );
  for (const control of found.controls)
    breach("§8.5", "/decisions", `the control "${control}" puts the queue into a past state`);
  // A position without a state cannot be asked what it is, so the rule above
  // would pass on it by saying nothing.
  if (found.stateless > 0)
    breach(
      "§8.5",
      "/decisions",
      `${found.stateless} positions carry no data-state — their state stays unmeasured`,
    );
  // Same currency, same reason: shape 5 — the settled word standing beside a
  // figure — is the ONE the other four cannot see, and with no text there is
  // nothing to look in. A silent `return` here left four shapes reported and the
  // fifth simply absent, under a verdict that read as a clean bill of health.
  if (found.text.length === 0)
    throw new NichtGemessen(
      "/decisions · §8.5: the page rendered no text at all, so the one shape the other four cannot " +
        "see — a settled word standing beside a figure — was not looked for.",
    );
  for (const [word, provenance] of SETTLED_WORDS) {
    const hit = countedWith(found.text, word);
    if (hit !== null)
      breach(
        "§8.5",
        "/decisions · the rendered text of the page",
        `"${word}" (${provenance}) stands beside a figure — a count of what is over: ${hit}`,
      );
  }
}

/**
 * §8.5 — exactly one way to the past, and it goes to the log.
 *
 * "genau einen Verweis — ein Satz mit Link, keine Zähler-Kacheln." So: one link
 * to /audit and not two, in a sentence, and no tile counting anything settled.
 */
async function checkHistoryLink(page) {
  const shape = await page.evaluate(() => {
    const links = [
      ...document.querySelectorAll('[data-testid="decisions-page"] a[href*="/audit"]'),
    ];
    const sentence = document.querySelector('[data-testid="decisions-history"]');
    return {
      count: links.length,
      href: links[0]?.getAttribute("href") ?? null,
      text: sentence instanceof HTMLElement ? sentence.innerText.replace(/\s+/g, " ").trim() : null,
    };
  });
  if (shape.count === 0) {
    breach("§8.5", "/decisions", "no way from the decisions page to the recorded history");
    return;
  }
  if (shape.count !== 1)
    breach("§8.5", "/decisions", `${shape.count} ways to the history instead of exactly one`);
  const expected = `${german("decisions.history.label")} ${german("decisions.history.link")}`;
  if (shape.text !== expected)
    breach(
      "§5",
      "/decisions · decisions-history",
      `reads "${shape.text}" instead of "${expected}"`,
    );
  if (!(shape.href ?? "").includes("scope=decisions"))
    breach(
      "§8.5",
      "/decisions · decisions-history",
      `the link leads to ${shape.href} — the log opens unfiltered and the history stays unfindable`,
    );
}

/**
 * §8.5 — where the past arrives as a machine value, the naming belongs in the log.
 *
 * SubKit records every decision: `patch_candidate.approved`,
 * `skill_candidate.rejected`, with the reason. Measured against the live tenant
 * on 21.08.2026, `/v1/audit-log?action=…` returned twenty such entries. And the
 * page rendered `entry.action` verbatim, so a complete history arrived as
 * engine strings, its resource column read "Unbekannt", and no filter led to
 * it. Present, complete, unfindable — which is the case §8.5 names.
 */
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

/**
 * §8.2 — kind chips are the one ordering control. A second grouping strip is
 * redundant and was removed from the family grammar in v1.7.
 */
async function checkGroupToggle(page) {
  if ((await page.locator('[data-testid="decisions-group"]').count()) > 0)
    breach("§8.2", "/decisions", "a redundant group toggle remains above the queue");
}

/**
 * §5 — a title is a summary in the reader's language, not the engine's artefact.
 *
 * `proposal.description` arrives as English change notes ("Field follows the
 * rename: …") and used to BE the card title, so the queue read as a list of
 * commit messages from another system.
 */
async function checkCorrectionTitles(page) {
  // The summary moved behind the named toggle when the cards became one line
  // each, and a closed panel is not in the DOM at all — the same lesson the
  // §8.5 rule below is built on. So: open every correction card first, or this
  // check would report the change note as MISSING on a page that carries it.
  const toggles = page.locator('article[data-decision-key^="patch:"] [aria-expanded="false"]');
  const closed = await toggles.count();
  for (let index = 0; index < closed; index += 1) {
    try {
      await toggles.nth(index).click({ timeout: 2_000 });
    } catch {
      // Handled by the assertion below: an unopenable card shows no note.
    }
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
    breach("§5", "/decisions", "no correction cards found, the title rule stays unmeasured");
    return;
  }
  const notes = PATCH_CANDIDATES.map((candidate) => candidate.diff.proposal.description);
  for (const card of cards) {
    if (!card.title || !/^Korrektur(: | für )/.test(card.title))
      breach("§5", "/decisions · correction card", `title "${card.title}"`);
    else if (notes.includes(card.title))
      breach("§5", "/decisions · correction card", `title is the engine's own change note`);
  }
  // The English note is the detail, and dropping it would trade one loss for
  // another: the reader still has to be able to see what would change.
  if (!cards.some((card) => card.summary && notes.includes(card.summary)))
    breach("§5", "/decisions · correction card", "the engine's change note is missing entirely");
}

/**
 * §5 — a label only a screen reader ever hears is still a label.
 *
 * The jump button in the chat carried its ONLY caption as sr-only text, hard
 * coded English. Nothing on the rendered page showed it, so no reading of the
 * screen could catch it — and for a German screen-reader user that string was
 * the entire account of what the button does.
 *
 * The rule is checked against the German catalog rather than against a list of
 * suspicious words: on a German page every screen-reader caption is a catalog
 * value, interpolation included. That way the check needs no vocabulary of its
 * own and still catches the next caption somebody types straight into a
 * component.
 */
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

/** §8.3 — a button names the act; "OK" and "Submit" name nothing. */
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

/** §5 — a title is a summary; an identifier on screen is never one. */
async function checkNoIdentifiers(page, where) {
  const text = await page.locator("body").innerText();
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

/**
 * §5 — a field label is a word somebody chose, not a lower-cased engine key.
 *
 * The catalogue detail pages built their overview from the response itself and
 * labelled each cell `key.replaceAll("_", " ")`. That is worse than an untranslated
 * string: it LOOKS designed. The tell is the casing — a machine-made label keeps
 * the engine's lower-case snake vocabulary, a chosen German one starts with a
 * capital. Nothing here needs to know which fields exist, which is why it also
 * catches the next field the engine adds.
 */
async function checkCuratedFieldLabels(page, where) {
  const raw = await page.evaluate(() =>
    [...document.querySelectorAll("dt")]
      .map((element) => element.textContent?.trim() ?? "")
      .filter((text) => /^[a-z][a-z0-9]*(?: [a-z0-9]+)*$/.test(text)),
  );
  for (const label of new Set(raw))
    breach("§5", where, `field name "${label}" is a passed-through engine key`);
}

/** §5 — a point in time is a readable time, not the transport's encoding. */
async function checkNoRawTimestamps(page, where) {
  const text = await page.locator("body").innerText();
  const match = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  if (match) breach("§5", where, `raw timestamp on the surface: ${match[0]}…`);
}

/**
 * §5 — the conversation's state line is German, whatever the engine sent.
 *
 * `buildOneSentence()` composes seven English sentences out of a stage, a
 * target and a next action. The cockpit translated exactly one of them, and
 * only on byte equality with the whole composed string — so six states were
 * English by construction, and the seventh went English too as soon as the
 * sentence arrived without its appended next action.
 *
 * Two claims are pinned, and the second is the one that lasts. The line must
 * not read as the engine's prose, AND it must not BE the engine's sentence:
 * a check that only forbids known English openings is a check the next wording
 * walks past. The exact German wording is pinned on top, so a cockpit that
 * silently stops naming the connector cannot pass either.
 */
const RESUME_LINE =
  "Du hast den Konnektor \u201eReporting API 1\u201c in prod entworfen, aber noch nicht geprobt.";

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

/**
 * §8.1 — four surfaces, one number.
 *
 * The badge, Zone A, the banner's base and the queue's own copy are compared
 * against each other rather than against a constant, because the failure this
 * asserts against is not a wrong number: it is two right-looking numbers that
 * were never the same question. The rendered positions are counted separately —
 * they are allowed to be FEWER than the total, and only when the page says so.
 */
async function checkCounterCoherence(page, surfaces) {
  const rendered = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("article[data-testid]")].filter((element) =>
      /^decision(-deferred|-aged)-\d+$/.test(element.getAttribute("data-testid") ?? ""),
    );
    const wrapper = document.querySelector('[data-testid="decisions-queue"]');
    const rubric = (id) => {
      const section = document.querySelector(`[data-testid="${id}"]`);
      if (!section) return null;
      const heading = section.querySelector("h1, h2, h3, h4");
      return {
        count: Number(section.getAttribute("data-count")),
        heading: heading instanceof HTMLElement ? heading.innerText.trim() : "",
      };
    };
    return {
      positions: cards.length,
      keys: cards.map((card) => card.getAttribute("data-decision-key")),
      total: wrapper?.getAttribute("data-total") ?? null,
      capped: wrapper?.getAttribute("data-capped") ?? null,
      rubrics: { aged: rubric("decisions-aged") },
    };
  });

  if (rendered.positions !== QUEUE_SHOWN)
    breach(
      "§8.1",
      "/decisions",
      `${rendered.positions} positions rendered, the fixture serves ${QUEUE_SHOWN} distinct ones`,
    );
  const distinct = new Set(rendered.keys.filter((key) => key !== null));
  if (distinct.size !== rendered.positions)
    breach(
      "§8.1",
      "/decisions",
      `${rendered.positions} cards but ${distinct.size} distinct positions — counted twice`,
    );
  if (rendered.total === null) {
    breach("§8.1", "/decisions · decisions-queue", "the queue does not name its total");
    return;
  }

  // Two numbers, each with its own scope, and neither may drift.
  //
  // The badge and Zone A count everything that waits on this person — that is
  // the whole page, tiles included. The queue counts what it holds, which is
  // the decidable part. Before the split there was one number for both, and it
  // was the queue's: a badge saying 35 above a list the reader was expected to
  // work through, 32 of whose entries could not be worked on here.
  const queueTotal = Number(rendered.total);
  const pageWide = {
    "nav-decisions-count": surfaces.badge === null ? null : Number(surfaces.badge),
    "overview-decision-kpis": surfaces.overviewDecisions,
  };
  for (const [where, value] of Object.entries(pageWide)) {
    if (value === null || value === undefined) continue;
    if (value !== QUEUE_TOTAL)
      breach(
        "§8.1",
        `/overview + /decisions · ${where}`,
        `shows ${value}, the page counts ${QUEUE_TOTAL}`,
      );
  }
  if (queueTotal !== DECIDABLE_TOTAL)
    breach(
      "§8.1",
      "/decisions · decisions-queue",
      `the queue claims ${queueTotal}, the decidable endpoints report ${DECIDABLE_TOTAL}`,
    );
  // The cap indicator must agree with the actual distinct decision count.
  if (rendered.capped !== String(rendered.positions < queueTotal))
    breach(
      "§8.1",
      "/decisions · decisions-queue",
      `${rendered.positions} of ${queueTotal} shown, but the cap indicator disagrees`,
    );
}

/**
 * §8.1 / §8.7 — the banner and the decisions page describe the same thing.
 *
 * Every claim the banner makes is read back against what the decisions page
 * says about the SAME positions. That used to be a rubric of the queue; it is
 * the conversation tile now, because both states the banner may claim — stopped
 * right now, deadline lapsed — belong to a waiting conversation and to nothing
 * else, and those left the queue.
 *
 * What is asserted is unchanged in substance and one shape stronger: the two
 * claims must be shares of the tile's number and never exceed it, their words
 * must be the two pinned German ones, and no claim may wear the heading of the
 * rubric that says it blocks nothing. The fixture keeps that rubric non-empty on
 * purpose; without one the last assertion proves nothing, so an empty one is
 * itself a breach.
 */
const BANNER_CLAIM_LABELS = {
  blocking: "Unterhaltungen, die auf deine Antwort warten",
  overdue: "Unterhaltungen mit verfallener Frist",
};

function _checkBannerAgainstConversations(banner, conversationTotal, rubrics) {
  if (!banner) {
    gap(
      "/overview vs. /decisions",
      "no banner was read — banner and decisions page cannot be reconciled",
    );
    return;
  }
  if (banner.total !== conversationTotal)
    breach(
      "§8.1",
      "/overview vs. /decisions",
      `banner states a share of ${banner.total}, the conversation source counts ${conversationTotal}`,
    );
  let stated = 0;
  for (const [name, claim] of Object.entries(banner.claims)) {
    stated += claim.count;
    const expected = BANNER_CLAIM_LABELS[name];
    if (expected === undefined) {
      breach("§8.7", "/overview", `banner makes an unknown claim "${claim.label}"`);
      continue;
    }
    if (claim.label !== expected)
      breach("§5", "/overview", `banner claims "${claim.label}" instead of "${expected}"`);
  }
  if (stated > conversationTotal)
    breach(
      "§8.1",
      "/overview vs. /decisions",
      `banner claims ${stated} positions out of ${conversationTotal}`,
    );

  if (!rubrics.aged || rubrics.aged.count === 0) {
    breach(
      "§8.7",
      "/decisions",
      "no populated rubric that blocks nothing — the banner boundary stays unmeasured",
    );
    return;
  }
  for (const claim of Object.values(banner.claims)) {
    if (claim.label === rubrics.aged.heading)
      breach(
        "§8.7",
        "/overview vs. /decisions",
        `banner claims "${rubrics.aged.heading}" — that rubric blocks nothing`,
      );
  }
}

/**
 * §4 / §5 — a broken answer meets a designed German state, not a catch-all.
 *
 * The knowledge page read `content.data?.documents[index]`: the optional chain
 * stopped after `.data?`, so a body without a `documents` array did not render
 * a failure — it threw, and the router's own default replaced the entire
 * cockpit with "Something went wrong! / Show Error". No sidebar, no product,
 * no way back, and not a German word on it.
 *
 * Both halves are pinned by one assertion, because for the reader they are one
 * fact: the shell stands, the page mounts, the state is German, and there is a
 * way out. Should the guard ever shorten again, the catch-all takes the page
 * and every one of those four claims fails at once.
 */
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

/** §8.1 / §8.7 — nothing open means no badge and no banner, not a quiet zero. */
async function checkSilentWhenEmpty(page) {
  const present = await page.evaluate(() => ({
    badge: Boolean(document.querySelector('[data-testid="nav-decisions-count"]')),
    banner: Boolean(document.querySelector('[data-testid="overview-incident"]')),
    zoneA: Boolean(document.querySelector('[data-testid="zone-a-decisions-count"]')),
  }));
  if (present.badge)
    breach("§8.1", "/overview (empty queue)", "counter badge despite zero open positions");
  if (present.banner) breach("§8.7", "/overview (empty queue)", "banner despite an empty queue");
  if (present.zoneA)
    breach("§1", "/overview (empty queue)", "zone A states a number although nothing is open");
}

/**
 * §5 / §2 / §12 — a detail surface that is NOT a route is swept too.
 *
 * The route table covers every detail PAGE. It cannot cover a detail view that
 * has no route of its own — the runs list opens its own in place — and a
 * surface with no address is exactly the surface nobody remembers to check.
 *
 * Which lists have one is deliberately not a table here. A collection is a page
 * that offers to open one of its rows, so this follows the affordance a person
 * follows: the first row's own open action. If that leads to an address, the
 * route table already swept it and there is nothing to repeat; if it opens in
 * place, this is the only chance to read it.
 */
async function sweepDetailSurface(page, route) {
  const opener = page.locator('[data-testid="data-table-open-0"]');
  if ((await opener.count()) === 0) {
    if ((await page.locator('[data-testid="data-table"]').count()) > 0)
      gap(`/${route} · detail surface`, "the list offers no row to open");
    return;
  }
  const listUrl = page.url();
  // THE SURFACE IS THERE AND THIS RUN COULD NOT READ IT — a different sentence
  // from "there is nothing here to read", and the line the three throws below
  // are drawn on. The list offered a row (the `return` above already covers the
  // case where it does not), so a row that will not open, a page that will not
  // settle and a skeleton that never leaves are all this run losing its grip on
  // a surface that exists. Six rules then go unmeasured on it: the six calls at
  // the end of this function — checkNoUnknownState, checkActionLabels,
  // checkNoIdentifiers, checkCuratedFieldLabels, checkNoRawTimestamps,
  // checkScreenReaderLanguage.
  //
  // A gap does not move the exit code. Reported as gaps, all three ended the run
  // at 0 with those six skipped — the same shape that was closed in
  // checkNothingSettled for a route, one level down on a detail surface. So they
  // abort with 2, in the currency this report already has for "this run says
  // nothing".
  //
  // The two gaps that STAY gaps below are the other sentence: no row to open,
  // and no dialog after opening one. Both say the surface is not there in this
  // fixture, and a surface that does not exist is a hole in what is covered, not
  // a failed reading.
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
  // An address means a route, and a route is swept from the table.
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
  // A skeleton is a promise, not a state: reading the page while one is up
  // measures the loading behaviour instead of the words. A skeleton that never
  // goes away is therefore not a thing to wait out quietly — and not a gap
  // either, for the reason given above: the dialog IS open, the six checks
  // below simply did not run on it.
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

// ─────────────────────────────────────────────────────────────────────────────
// WHOSE CONSOLE ANSWERED
//
// `startPreview` answers "is something there?", not "is SubKit there?". At
// CodeKit that gap produced 8 breaches in 156 s against a surface that was
// WorkKit — no timeout, no crash, a complete and convincing false report.
//
// The family makes it likely: §7 keeps the DOM anchors identical across all six
// consoles, so a sister console satisfies every precondition this run would
// otherwise fail on, and the stands sit next to each other (4081 · 4173 · 4176
// · 4183 · 4192).
//
// The expected value is DERIVED, never typed: one definition site,
// apps/cockpit/index.html. A renamed attribute then reports the true sentence —
// the value is no longer derivable from that file — instead of "foreign
// document" about our own console. And deliberately not the title or wordmark:
// §6 must be able to find those broken, and an identity that is also under test
// turns every real breach into "that is not SubKit".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A run that did not measure, as opposed to one that measured and found breaches.
 *
 * Exit 1 is a work list, exit 2 is an absent measurement. For a mandatory gate
 * stage that is the difference between repairing and muting — the confusion that
 * cost CodeKit eight repairs on someone else's surface.
 */
class NichtGemessen extends Error {}

/**
 * THE DOOR — every page of this run comes through it, and it names what it opens.
 *
 * There used to be an `assertPruefstandsKennung(page)` here, called once on a
 * shell page before the sweep. That is asking, not knowing: the shell was one
 * document and every measured route was another. On a stand that changes hands
 * after its first answer the question gets SubKit once and the run measures a
 * sister console for the rest — the sibling harness measured 1 honest answer
 * against 240 foreign ones that way, at exit 0.
 *
 * `visit()` puts the question at the navigation instead. A foreign console is
 * not a breach, it is a run that did not happen, so `refuse` builds
 * `NichtGemessen` (exit 2) and not a line somebody works off.
 *
 * `stand.identity` holds the identity of the LAST answer and is withdrawn at the
 * start of every navigation. A stand that changed hands has no confirmed
 * identity any more: leaving the old one standing printed "Stand: … identity
 * SubKit" above an abort that named WorkKit — one report saying two things.
 */
const stand = standAt({
  baseUrl,
  refuse: (satz, optionen) => new NichtGemessen(satz, optionen),
});

async function startPreview() {
  // Reachability only. WHOSE console it is, is a question for the browser —
  // this function may not answer it, because an answer read here would be read
  // by a second parser and could differ from the one that measures.
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
    } catch {
      // The server is still binding; the deadline is the only give-up signal.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  server.kill();
  throw new NichtGemessen(`preview server did not answer on ${baseUrl} within 60s`);
}

/**
 * Does the page not mount, or does nobody answer any more?
 *
 * Asked by EFFECT, not by reading the message: the shell is loaded again through
 * the door, so status AND identity are re-settled. A dead stand and a §6 breach
 * look identical from inside the sweep, and the loop used to file the dead one
 * as a finding — killing the preview server at route 11 produced 16 invented
 * "page does not mount" breaches and exit 1, a complete and convincing work list
 * about nothing.
 *
 * Going through the door also covers the second case: the port stayed open, but
 * a sister console took it over. A port says that somebody answers, never who.
 *
 * It is the ONLY place where a mount failure is still worth a second question.
 * Every navigation settles the identity for itself now; this one settles what a
 * timed-out MOUNT means, which is a different question.
 */
async function assertStandStillAnswers(cause) {
  // No reader, no second question. Everything that fails BEFORE `chromium
  // .launch()` returns — a preview that never came up, a browser that is not
  // installed on this machine — arrives here with `browser` still null, and the
  // first line below then threw "null is not an object (evaluating
  // 'browser.newPage')". That TypeError became the reported cause: a run that
  // could not measure named ITS OWN null pointer instead of the missing
  // Chromium, and the report sent the reader looking in the wrong place.
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
  // The door: this page reaches its route and says whose console it is, or the
  // run stops. There is no second step that could be skipped.
  await stand.visit(page, target);
  const marker = MOUNT_MARKERS[route] ?? `[data-testid="resource-${route}"]`;
  await page.locator(marker).waitFor({ state: "visible", timeout: 15_000 });
  return page;
}

/**
 * §4 / family S1–S3 — prove the three collection states in the shipped bundle.
 * Production data cannot safely be emptied or failed for a screenshot, so the
 * mandatory browser gate controls one read locally and checks rendered DOM.
 */
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

/** §8.8 — a newer engine enum may arrive before this cockpit is replaced. */
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
  const page = await openPage(context, "decisions");
  try {
    const queue = page.locator('[data-testid="decisions-queue"]');
    if (
      (await queue.count()) !== 1 ||
      (await page.locator('[data-testid^="decision-"]').count()) === 0
    )
      breach(
        "§4, §8.8",
        "/decisions unknown kind",
        "the queue dropped the future kind or unmounted",
      );
    const text = await page.locator('[data-testid="decisions-page"]').innerText();
    if (text.includes("future_operator_choice"))
      breach("§5, §8.8", "/decisions unknown kind", "raw future_operator_choice enum is visible");
  } finally {
    await page.close();
    await context.close();
  }
}

// The one rule that needs neither a browser nor a server, measured before
// either is started: a preview that never comes up must not also cost the
// version assert.
checkKonventionVersion();

/**
 * Why the whole measurement sits inside a catch: an exception used to end the
 * process on the spot, printing a stack trace where the report belongs and
 * taking every breach collected so far with it. The exit code was right — but a
 * run that could not measure has to SAY so, in the same shape as every other
 * outcome, or the reader of a mandatory gate stage cannot tell "nothing found"
 * from "nothing looked at".
 */
// BEFORE the preview server and the browser start. A run whose vocabulary has
// drifted must cost milliseconds and say so, not produce a clean report.
assertSettledAlphabetIsCurrent();

let abbruch = null;
let server = null;
let browser = null;
// How far the route sweep got. `NichtGemessen` only ever covered the window
// BEFORE the first route, so a preview server that died mid-sweep — route 11 of
// 27 — exited 1, "measured and red", carrying the one breach recorded just
// before the throw as if it were a finding while 16 routes were never looked at.
let besuchteRouten = 0;
let routenDurchlaufen = false;
try {
  const preview = await startPreview();
  server = preview.server;

  // The browser starts BEFORE the first question, because it IS the reader.
  // The shell is opened first so a foreign or dead stand costs a second instead
  // of a full run against somebody else's surface — 156 s and eight findings at
  // CodeKit. It is an EARLY door, not the only one: the identity is settled
  // again at every navigation below, because a stand can change hands after
  // answering.
  browser = await chromium.launch({ headless: true });
  const schale = await browser.newPage();
  try {
    await stand.visit(schale, "", { waitUntil: "domcontentloaded" });
  } finally {
    await schale.close();
  }

  // German is the top-level language of the convention (§5), and every pinned
  // string it names is a German one.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "de-DE",
  });
  await context.addInitScript(() => {
    localStorage.setItem("sk-cockpit-locale", "de");
    localStorage.setItem("sk-cockpit-theme", "light");
  });
  await context.route("**/v1/**", apiMock(true));

  const overview = await openPage(context, "");
  await checkWordmark(overview);
  await checkBrowserTitle(overview);
  await checkFavicon(overview);
  await checkRoleLabel(overview);
  await checkAdminGroupName(overview);
  await checkInstallationEntries(overview);
  const badgeValue = await checkDecisionsNavEntry(overview);
  const overviewDecisions = await checkOperationalDashboard(overview, QUEUE_TOTAL);
  await overview.close();

  const decisions = await openPage(context, "decisions");
  await checkAgingRubric(decisions);
  await checkRubricLanguage(decisions);
  await checkDecisionAnatomy(decisions);
  await checkCorrectionTitles(decisions);
  await checkCounterCoherence(decisions, {
    badge: badgeValue,
    overviewDecisions,
  });
  await checkGroupToggle(decisions);
  await checkHistoryLink(decisions);
  // Last on this page: it opens every collapsible it can find, and a page left
  // expanded would make the assertions above measure a different surface.
  await checkNothingSettled(decisions);
  await decisions.close();

  // The other end of the one link §8.5 allows. Opened with the scope the link
  // carries, because an unfiltered log proves nothing about findability.
  const auditHistory = await context.newPage();
  await stand.visit(auditHistory, "audit?scope=decisions");
  await auditHistory
    .locator('[data-testid="resource-audit"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  await checkDecisionHistoryIsReadable(auditHistory);
  await auditHistory.close();

  const operations = await openPage(context, "operations");
  await checkOperationsIsToolsOnly(operations);
  await operations.close();

  const chat = await openPage(context, "chat");
  await checkResumeLine(chat);
  await chat.close();

  for (const route of ROUTES) {
    besuchteRouten += 1;
    // Progress on stderr, one line per route: the sweep is the long part of a
    // mandatory gate stage, and "aborted at route 11" is only checkable against
    // a run that said where it was.
    console.error(`route ${besuchteRouten}/${ROUTES.length}: /${route}`);
    let page;
    try {
      page = await openPage(context, route);
    } catch (error) {
      // A run that was refused at the door is not a work list — it is not a run.
      // Rethrowing rather than probing again: the door has already settled that
      // this stand is not ours, and a breach written here would be a line about
      // somebody else's surface.
      if (error instanceof NichtGemessen) throw error;
      // Asked BEFORE the breach is written: a dead stand must not become a line
      // somebody works off.
      await assertStandStillAnswers(error);
      breach("§6", `/${route}`, `page does not mount: ${error.message}`);
      continue;
    }
    await checkNoUnknownState(page, `/${route}`);
    await checkActionLabels(page, `/${route}`);
    await checkNoIdentifiers(page, `/${route}`);
    await checkCuratedFieldLabels(page, `/${route}`);
    await checkNoRawTimestamps(page, `/${route}`);
    await checkScreenReaderLanguage(page, `/${route}`);
    await sweepDetailSurface(page, route);
    await page.close();
  }
  routenDurchlaufen = true;
  await context.close();

  await checkCollectionDataStates(browser);
  await checkUnknownDecisionKind(browser);

  // Second fixture variant: nothing open, so the banner must be gone.
  const calm = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "de-DE",
  });
  await calm.addInitScript(() => {
    localStorage.setItem("sk-cockpit-locale", "de");
    localStorage.setItem("sk-cockpit-theme", "light");
  });
  await calm.route("**/v1/**", apiMock(false));
  const calmOverview = await openPage(calm, "");
  await checkOperationalDashboard(calmOverview, 0);
  await checkSilentWhenEmpty(calmOverview);
  await calmOverview.close();
  await calm.close();

  // Third fixture variant: one endpoint answers with a body the page cannot
  // read. A cockpit is judged by what it does when an answer is wrong, not
  // only by what it does when everything is right.
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
    if (path === `/v1/knowledge-sources/${ID}/content`) return json(route, { items: [], total: 0 });
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
  // Everything outside the route loop lands here — the four pages before it, the
  // two fixture variants after it. Same question: was that the console failing,
  // or was there nobody left to ask?
  if (!(error instanceof NichtGemessen)) {
    try {
      await assertStandStillAnswers(error);
    } catch (dead) {
      // The verdict, or nothing. `assertStandStillAnswers` answers a question —
      // "was that the console failing, or is nobody left to ask" — and its
      // answer is a NichtGemessen. Anything else coming out of it is the
      // measuring instrument breaking, and an instrument's own fault must never
      // take the place of the cause it was asked about.
      abbruch = dead instanceof NichtGemessen ? dead : error;
    }
  }
} finally {
  await browser?.close();
  server?.kill();
}

// What was looked at and what was not is printed in both outcomes: a check
// that names its blind spot only when it fails hides it precisely when the
// reader believes it (§12).
//
// The closing block names the MEASUREMENT, not only its result. As a mandatory
// gate stage this last line is read as a certificate, and "keine Verstöße"
// certifies nothing on its own: against which document, on how many routes, on
// which stand, in which language. Everything it did NOT look at stands right
// next to it, in the passing case as much as in the failing one.
// An abort that never got through the route list is not a red run, it is an
// absent one — the same distinction `NichtGemessen` draws for the window before
// the first route, applied to the window the routes themselves occupy.
const nichtGemessen = abbruch instanceof NichtGemessen || (Boolean(abbruch) && !routenDurchlaufen);
const gescheitert = violations.length > 0 || Boolean(abbruch);
const report = gescheitert ? console.error : console.log;

// The label comes from the file; the assert above does not (§7). Printing the
// number the document names is honest reporting; comparing it to a number this
// file carries by hand is the part that can fail.
const massstab = konventionVersionImRepo
  ? `COCKPIT-KONVENTION.md v${konventionVersionImRepo}`
  : "COCKPIT-KONVENTION.md (header line without a readable version)";
// The identity stands beside the stand in BOTH outcomes: an address is not an
// identity. Without a confirmed one the description is WITHDRAWN rather than
// qualified — "the built version the engine ships" is simply false about a
// foreign console, and a trailing caveat does not make a false sentence true.
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
