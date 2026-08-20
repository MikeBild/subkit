import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// The family convention (COCKPIT-KONVENTION.md) is deliberately not enforced by
// shared code — six products copy patterns, they do not import them (§7). What
// is left is drift, so the rules that can be observed on a rendered page are
// asserted here against this repo's own cockpit.
//
// It runs against the built bundle with every /v1 call mocked, so it needs
// neither a database nor a running engine and reports the same verdict on any
// machine. It reports EVERY breach it finds rather than stopping at the first:
// the output is the work list for the next conformity round, and a list that
// truncates itself hides the size of the gap.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const previewPort = Number(process.env.COCKPIT_PREVIEW_PORT || 4176);
const externalBaseUrl = process.env.COCKPIT_BASE_URL?.replace(/\/$/, "");
const baseUrl = externalBaseUrl || `http://127.0.0.1:${previewPort}`;

// Every route the shell can reach. The rules about forbidden words and
// unlabelled actions are DOM-wide claims, and a claim checked on two pages is
// not the claim the convention makes.
const ROUTES = [
  "overview",
  "decisions",
  "chat",
  "inbox",
  "workflows",
  "runs",
  "connectors",
  "knowledge",
  "skills",
  "files",
  "audit",
  "usage",
  "people",
  "access",
  "api-access",
  "operations",
  "notifications",
  "settings",
];

const MOUNT_MARKERS = {
  overview: '[data-testid="overview-page"]',
  decisions: '[data-testid="decisions-page"]',
  chat: '[data-testid="chat-workspace"]',
  people: '[data-testid="admin-people"]',
  access: '[data-testid="admin-access"]',
  "api-access": '[data-testid="admin-api-access"]',
  operations: '[data-testid="admin-operations"]',
  notifications: '[data-testid="admin-notifications"]',
  settings: '[data-testid="admin-settings"]',
  workflows: '[data-testid="catalog-workflows"]',
  connectors: '[data-testid="catalog-connectors"]',
  knowledge: '[data-testid="catalog-knowledge"]',
  skills: '[data-testid="catalog-skills"]',
  files: '[data-testid="catalog-files"]',
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

// The engine counts more waiting conversations than one page of them delivers.
// Without this the fixture could never tell an exact total from a rendered row
// count, which is precisely the confusion §8.1 is about.
const CONVERSATION_TOTAL = AWAITING_CONVERSATIONS.length + 2;

/** The number every surface must show: the engine's own counts, summed. */
const QUEUE_TOTAL = PATCH_CANDIDATES.length + SKILL_CANDIDATES.length + CONVERSATION_TOTAL;

/** The number of distinct positions the page can actually render. */
const QUEUE_SHOWN =
  PATCH_CANDIDATES.length + SKILL_CANDIDATES.length + AWAITING_CONVERSATIONS.length;

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
    last_seen: days(0),
    cause: "Das angebundene System antwortet seit gestern mit einem Fehler.",
    guidance: "Zugangsdaten prüfen und den Lauf erneut anstoßen.",
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

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/**
 * One handler for every /v1 call the cockpit makes.
 *
 * `gateOpen` is the only switch: §8.7 makes two opposite claims about the same
 * page, and the banner rule is only proven when the fixture can also produce
 * the state in which the banner must be absent.
 */
function apiMock(gateOpen) {
  return async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const status = url.searchParams.get("status");

    if (path === "/v1/cockpit/bootstrap") return json(route, BOOTSTRAP);
    if (path === "/v1/operator/health-digest") return json(route, healthDigest(gateOpen));

    // The three decision sources follow `gateOpen` too: the badge, Zone A and
    // the banner all read them now, so the calm variant has to be able to say
    // "nothing is open" through the same endpoints the busy one uses.
    if (path === "/v1/patch-candidates") {
      const items = gateOpen && status === "proposed" ? PATCH_ROWS : [];
      return json(route, { items, total: gateOpen ? PATCH_CANDIDATES.length : 0 });
    }
    if (path === "/v1/skill-candidates") {
      const items = gateOpen && status === "proposed" ? SKILL_CANDIDATES : [];
      return json(route, { items, total: items.length });
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
            parts: [{ type: "text", text: "Ich habe die fehlerhafte Umwandlung eingegrenzt." }],
          },
        ],
        tool_calls: [],
        resume_summary: {
          active_target: { kind: "none", name: "none", slug: null, id: null, environment: null },
          stage: "onboarding",
          last_successful_probe: null,
          last_successful_preview: null,
          unsaved: false,
          pending_approval: null,
          next_action: "Continue the conversation.",
          one_sentence: "You have an in-progress conversation.",
        },
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
      const items = catalogRows(path);
      const categories =
        path === "/v1/workflows" || path === "/v1/connectors"
          ? [
              { category: "reporting", count: 4 },
              { category: "betrieb", count: 4 },
            ]
          : undefined;
      return json(route, { items, total: items.length, ...(categories ? { categories } : {}) });
    }

    if (path === "/v1/executions") {
      const items = Array.from({ length: 8 }, (_, index) => {
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
      return json(route, { items, total: items.length, next_cursor: null });
    }

    if (path === "/v1/audit-log")
      return json(route, {
        items: Array.from({ length: 8 }, (_, index) => {
          const rotate = index % 4;
          return {
            id: index === 0 ? ID : `audit-${index}`,
            ts: new Date(NOW - index * 120_000).toISOString(),
            tenant_id: ID,
            actor_type: ["user", "system_account", "system", "user"][rotate],
            actor_id: rotate === 2 ? null : ID,
            action: ["workflow.update", "connector.test", "skill.archive", "settings.write"][
              rotate
            ],
            resource_type: ["workflow", "connector", "skill", "settings"][rotate],
            resource_id: rotate === 3 ? null : ID,
            result: ["success", "success", "denied", "error"][rotate],
            trace_id: null,
            ip: null,
            user_agent: null,
            reason: rotate === 2 ? "Rolle deckt skill:write nicht ab." : null,
            metadata: {},
          };
        }),
        next_cursor: null,
      });

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
      const duration = { total: 44_400, avg: 1110, p50: 850, p95: 2300, p99: 2700, max: 3200 };
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

    if (path === "/v1/settings")
      return json(route, {
        items: [
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
          },
          {
            id: "user-2",
            email: "redaktion@example.org",
            role: "member",
            effective_role: "member",
            role_consistent: true,
            status: "active",
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
          { id: ID, name: "admin", description: "Workspace administration", is_builtin: true },
          {
            id: "role-2",
            name: "metrics_scraper",
            description: "Prometheus scraper",
            is_builtin: true,
          },
        ],
      });
    if (path === "/v1/rbac/groups")
      return json(route, { items: [{ id: ID, name: "Betrieb", description: "Operators" }] });
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
        items: [{ name: "workflow:run", description: "Run workflows", resource_type: "workflow" }],
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

/** §6 — the admin navigation group is called "Installation", never "Administration". */
async function checkAdminGroupName(page) {
  const group = page.locator('[data-testid="nav-group-admin"]');
  if ((await group.count()) === 0) {
    breach("§6", "/overview · Sidebar", "keine Admin-Nav-Gruppe vorhanden");
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
      breach("§6", "/overview · nav-group-admin", `Eintrag "${entry}" fehlt`);
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
    breach("§6, §8.1", "/overview · Sidebar", 'kein Nav-Eintrag "Entscheidungen"');
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
      `steht unter der Gruppenüberschrift "${placement.groupHeading}" statt ungruppiert`,
    );
  if (placement && placement.previous !== "nav-overview")
    breach(
      "§8.1",
      "/overview · nav-decisions",
      `steht nicht direkt unter der Übersicht (davor: ${placement.previous})`,
    );

  const badge = page.locator('[data-testid="nav-decisions-count"]');
  if ((await badge.count()) === 0) {
    breach("§8.1", "/overview · nav-decisions", "kein Zähler-Badge am Eintrag");
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
async function checkIncidentBanner(page, gateOpen) {
  const banner = page.locator('[data-testid="overview-incident"]');
  const present = (await banner.count()) > 0;
  if (!gateOpen) {
    if (present)
      breach("§8.7", "/overview (Fixture ohne offenes Gate)", "Banner trotz all-clear sichtbar");
    return;
  }
  if (!present) {
    breach("§8.7", "/overview (Fixture mit offenem Gate)", "kein Incident-Banner im DOM");
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
    breach("§8.7", "/overview", "Kacheln fehlen, Bannerposition nicht bestimmbar");
    return;
  }
  if (!shape.before) breach("§8.7", "/overview", "Banner steht im DOM nach den Kacheln");
  if (shape.links.length !== 1)
    breach(
      "§8.7",
      "/overview · overview-incident",
      `${shape.links.length} Links statt genau einem`,
    );
  else if (!shape.links[0].includes("/decisions"))
    breach("§8.7", "/overview · overview-incident", `Link zeigt auf ${shape.links[0]}`);
  return checkBannerSubset(page);
}

/**
 * §8.1 / §8.7 — the banner names a SUBSET, and says of what.
 *
 * A bare count beside a different count in Zone A is what made one screen show
 * 25, 30 and 119 without a word about how the three were related. The sentence
 * has to state both numbers, and the numbers have to be readable as numbers so
 * the four surfaces can be compared against each other rather than by eye.
 */
const BANNER_SENTENCE =
  /^(Alle \d+|Mindestens \d+ von \d+|\d+ von \d+) blockieren ihren Workflow\.$/;

async function checkBannerSubset(page) {
  const subset = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="incident-decisions-count"]');
    if (!element) return null;
    return {
      text: element.innerText.trim(),
      count: element.getAttribute("data-subset"),
      total: element.getAttribute("data-subset-total"),
    };
  });
  if (!subset) {
    breach("§8.1", "/overview · overview-incident", "Banner nennt keine Teilmenge");
    return null;
  }
  if (!BANNER_SENTENCE.test(subset.text))
    breach("§8.1", "/overview · incident-decisions-count", subset.text);
  const count = Number(subset.count);
  const total = Number(subset.total);
  if (!(count > 0 && count <= total))
    breach(
      "§8.1",
      "/overview · incident-decisions-count",
      `Teilmenge ${subset.count} passt nicht in Gesamtzahl ${subset.total}`,
    );
  return total;
}

/** §1 — Zone A's head is the same number the badge carries, or the page lies. */
async function readZoneACount(page) {
  const value = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="zone-a-decisions-count"]');
    return element instanceof HTMLElement ? element.innerText.trim() : null;
  });
  if (value === null) {
    breach("§1, §8.1", "/overview · overview-waiting", "Zone A nennt keine Anzahl");
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
  if (echo.cause)
    breach("§12", "/operations", "wiederholt die Fehlergruppen-Ursache der Übersicht");
  if (echo.groups > 0)
    breach("§12", "/operations", `${echo.groups} Fehlergruppen-Zeilen neben der Übersicht`);
  if (echo.risks > 0)
    breach("§12", "/operations", `${echo.risks} Risiko-Zeilen neben der Übersicht`);
  if (!echo.link) breach("§12", "/operations", "kein Weg zu den Befunden auf der Übersicht");
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
    breach("§8.2", "/decisions", "keine Aging-Rubrik, obwohl Positionen älter als 3 Tage sind");
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
    breach("§8.2", "/decisions", `${wearing} Rubriken heißen "${AGED_RUBRIC}" statt genau einer`);
  for (const forbidden of ["Kann warten"]) {
    if (headings.includes(forbidden))
      breach("§8.2", "/decisions", `Rubrik "${forbidden}" urteilt für den Leser`);
  }
}

/**
 * §5 — a title is a summary in the reader's language, not the engine's artefact.
 *
 * `proposal.description` arrives as English change notes ("Field follows the
 * rename: …") and used to BE the card title, so the queue read as a list of
 * commit messages from another system.
 */
async function checkCorrectionTitles(page) {
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
    breach("§5", "/decisions", "keine Korrektur-Karten gefunden, Titel-Regel ungeprüft");
    return;
  }
  const notes = PATCH_CANDIDATES.map((candidate) => candidate.diff.proposal.description);
  for (const card of cards) {
    if (!card.title || !/^Korrektur(: | für )/.test(card.title))
      breach("§5", "/decisions · Korrektur-Karte", `Titel "${card.title}"`);
    else if (notes.includes(card.title))
      breach("§5", "/decisions · Korrektur-Karte", `Titel ist der Änderungstext der Engine`);
  }
  // The English note is the detail, and dropping it would trade one loss for
  // another: the reader still has to be able to see what would change.
  if (!cards.some((card) => card.summary && notes.includes(card.summary)))
    breach("§5", "/decisions · Korrektur-Karte", "der Änderungstext der Engine fehlt ganz");
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
      /^decision(-expired|-deferred|-aged)?-\d+$/.test(element.getAttribute("data-testid") ?? ""),
    );
    const wrapper = document.querySelector('[data-testid="decisions-queue"]');
    return {
      positions: cards.length,
      keys: cards.map((card) => card.getAttribute("data-decision-key")),
      total: wrapper?.getAttribute("data-total") ?? null,
      capped: wrapper?.getAttribute("data-capped") ?? null,
    };
  });

  if (rendered.positions !== QUEUE_SHOWN)
    breach(
      "§8.1",
      "/decisions",
      `${rendered.positions} Positionen gerendert, Fixture liefert ${QUEUE_SHOWN} verschiedene`,
    );
  const distinct = new Set(rendered.keys.filter((key) => key !== null));
  if (distinct.size !== rendered.positions)
    breach(
      "§8.1",
      "/decisions",
      `${rendered.positions} Karten, aber ${distinct.size} verschiedene Positionen — doppelt gezählt`,
    );
  if (rendered.total === null) {
    breach("§8.1", "/decisions · decisions-queue", "Queue nennt ihre Gesamtzahl nicht");
    return;
  }

  const queueTotal = Number(rendered.total);
  const named = {
    "nav-decisions-count": surfaces.badge === null ? null : Number(surfaces.badge),
    "zone-a-decisions-count": surfaces.zoneA,
    "incident-decisions-count": surfaces.bannerTotal,
    "decisions-queue": queueTotal,
  };
  for (const [where, value] of Object.entries(named)) {
    if (value === null || value === undefined) continue;
    if (value !== queueTotal)
      breach(
        "§8.1",
        `/overview + /decisions · ${where}`,
        `zeigt ${value}, die Queue zählt ${queueTotal}`,
      );
  }
  if (queueTotal !== QUEUE_TOTAL)
    breach(
      "§8.1",
      "/decisions · decisions-queue",
      `Gesamtzahl ${queueTotal}, Fixture-Endpunkte melden ${QUEUE_TOTAL}`,
    );
  // The fixture delivers fewer positions than the engine counts, so the page
  // must say so rather than let the badge and the column disagree in silence.
  if (rendered.capped !== "true")
    breach(
      "§8.1",
      "/decisions · decisions-queue",
      `${rendered.positions} von ${queueTotal} gezeigt, aber nicht als gekürzt ausgewiesen`,
    );
}

/** §8.1 / §8.7 — nothing open means no badge and no banner, not a quiet zero. */
async function checkSilentWhenEmpty(page) {
  const present = await page.evaluate(() => ({
    badge: Boolean(document.querySelector('[data-testid="nav-decisions-count"]')),
    banner: Boolean(document.querySelector('[data-testid="overview-incident"]')),
    zoneA: Boolean(document.querySelector('[data-testid="zone-a-decisions-count"]')),
  }));
  if (present.badge)
    breach("§8.1", "/overview (leere Queue)", "Zähler-Badge trotz null offener Positionen");
  if (present.banner) breach("§8.7", "/overview (leere Queue)", "Banner trotz leerer Queue");
  if (present.zoneA)
    breach("§1", "/overview (leere Queue)", "Zone A nennt eine Zahl, obwohl nichts offen ist");
}

async function startPreview() {
  if (externalBaseUrl) return null;
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
      if (response.ok) return server;
    } catch {
      // The server is still binding; the deadline is the only give-up signal.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  server.kill();
  throw new Error(`preview server did not answer on ${baseUrl} within 60s`);
}

async function openPage(context, route) {
  const page = await context.newPage();
  const response = await page.goto(`${baseUrl}/cockpit/${route}`, { waitUntil: "networkidle" });
  if (!response?.ok()) throw new Error(`/${route} returned HTTP ${response?.status()}`);
  const marker = MOUNT_MARKERS[route] ?? `[data-testid="resource-${route}"]`;
  await page.locator(marker).waitFor({ state: "visible", timeout: 15_000 });
  return page;
}

const server = await startPreview();
const browser = await chromium.launch({ headless: true });
try {
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

  const overview = await openPage(context, "overview");
  await checkRoleLabel(overview);
  await checkAdminGroupName(overview);
  await checkInstallationEntries(overview);
  const badgeValue = await checkDecisionsNavEntry(overview);
  const bannerTotal = await checkIncidentBanner(overview, true);
  const zoneA = await readZoneACount(overview);
  await overview.close();

  const decisions = await openPage(context, "decisions");
  await checkAgingRubric(decisions);
  await checkCorrectionTitles(decisions);
  await checkCounterCoherence(decisions, { badge: badgeValue, zoneA, bannerTotal });
  await decisions.close();

  const operations = await openPage(context, "operations");
  await checkOperationsIsToolsOnly(operations);
  await operations.close();

  for (const route of ROUTES) {
    let page;
    try {
      page = await openPage(context, route);
    } catch (error) {
      breach("§6", `/${route}`, `Seite mountet nicht: ${error.message}`);
      continue;
    }
    await checkNoUnknownState(page, `/${route}`);
    await checkActionLabels(page, `/${route}`);
    await checkNoIdentifiers(page, `/${route}`);
    await page.close();
  }
  await context.close();

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
  const calmOverview = await openPage(calm, "overview");
  await checkIncidentBanner(calmOverview, false);
  await checkSilentWhenEmpty(calmOverview);
  await calmOverview.close();
  await calm.close();
} finally {
  await browser.close();
  server?.kill();
}

if (violations.length === 0) {
  console.log(`Konvention-Check bestanden: ${ROUTES.length} Routen, keine Verstöße.`);
  process.exit(0);
}

console.error(`Konvention-Check: ${violations.length} Verstöße gegen COCKPIT-KONVENTION.md\n`);
for (const { rule, where, actual } of violations) {
  console.error(`  ${rule} · ${where}\n      ist: ${actual}`);
}
process.exit(1);
