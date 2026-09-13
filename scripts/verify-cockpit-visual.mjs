import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { chromium } from "playwright";

import { AuditAction } from "../apps/engine/src/audit/types.ts";
import { verifyDecisionLifecycle } from "./lib/cockpit-decisions.mjs";
import { standAt } from "./lib/cockpit-identity.mjs";
import { verifyWorkflowAuthorities } from "./lib/cockpit-workflow-authorities.mjs";
import { verifyWorkflowPreview } from "./lib/cockpit-workflow-preview.mjs";

/** A port nothing is listening on right now — claimed immediately with --strictPort. */
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

/** Start `vite preview` over the built cockpit and wait until it answers. */
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

/**
 * The sweep serves the build it is checking.
 *
 * It used to point at a fixed default port and photograph whatever answered
 * there. Twice now that was a masterless preview of a FOREIGN session: the
 * identity stand below asks "which product?" and gets the right answer, because
 * the other process is serving this same product from a different working tree.
 * A run then measures somebody else's cockpit — on 2026-09-04 that showed up as
 * a chat page failing an assertion about a sidebar the checked-out source
 * plainly renders, and cost an hour before the port was looked at.
 *
 * So unless an operator names a target explicitly, this script now starts a
 * `vite preview` over `assets/cockpit` on a port it picked, and takes it down
 * again. That also makes the check runnable in CI without a second step.
 */
const spawnedPreview = process.env.COCKPIT_BASE_URL ? null : await startPreviewServer();
const baseUrl = (process.env.COCKPIT_BASE_URL || spawnedPreview.baseUrl).replace(/\/$/, "");
const outputDir = resolve(process.env.COCKPIT_SCREENSHOT_DIR || ".artifacts/cockpit-sweep/local");
const uuid = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
const routes = [
  // The landing page was never photographed, which is how a whole class of
  // page-shell defect stayed invisible to this sweep.
  "",
  "decisions",
  "chat",
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
  "connections",
  "operations",
  "settings",
];

/**
 * The audit rows this sweep photographs — and the promise that they are REAL.
 *
 * A fixture that invents a verb photographs a world that does not exist: the
 * frame looks like evidence, the row can never appear in a running product, and
 * no defect in how that row is NAMED can ever be seen in it. Four invented verbs
 * were removed from this list once (`workflow.update`, `connector.test`,
 * `skill.archive`, `settings.write`) and the same commit left `settings.updated`
 * standing — a fifth, spelled plausibly enough that reading the list did not
 * catch it. Reading is not the instrument; `AuditAction` is.
 *
 * So the rows are checked against the engine's own enum BEFORE the browser
 * starts. It exits 2 — not 1 — because an invented verb is not a finding about
 * the cockpit: it is a sweep that measured a fiction, and "measured nothing"
 * must never leave as "found nothing".
 */
const AUDIT_FIXTURE_ROWS = [
  {
    action: "patch_candidate.approved",
    resource_type: "patch_candidate",
    result: "success",
  },
  {
    action: "skill_candidate.rejected",
    resource_type: "skill_candidate",
    result: "success",
  },
  { action: "workflow.updated", resource_type: "workflow", result: "success" },
  { action: "connector.invoked", resource_type: "connector", result: "denied" },
  { action: "settings.changed", resource_type: "settings", result: "error" },
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

// Deliberately unfriendly: a conversation the engine never named must make the
// cockpit's own fallback wording appear in a screenshot. Fixtures that always
// carry a title are fixtures that can never photograph "Untitled".
// Deadlines are stamped against the run, not against a frozen fixture instant:
// with a fixed date every waiting card is already expired by the time anyone
// looks, and the state that matters — blocking, with time left — is never seen.
const SWEEP_NOW = Date.now();

const conversations = Array.from({ length: 32 }, (_, index) => {
  // Every third conversation is waiting on an answer, and carries the question
  // it is waiting on. Without that the decisions queue photographs a card that
  // says "waiting for your answer" and nothing about what for.
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
    // What the row has come to, where it came from and whose it is — the
    // list reads these, never the status word.
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
          // Alternating lengths on purpose. A question that fits shows the
          // collapsed line uncut; one that does not is the only way a
          // screenshot can prove the expanded panel carries more than the
          // line above it — the defect that made expanding a conversation
          // card pointless was invisible to a short fixture.
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
    // Two @-mentions, one of which the engine could not resolve: the chip
    // for a workflow that exists and the struck-through warning chip for a
    // connector that is gone. A fixture where every mention resolves would
    // photograph the warning state never.
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
    // An answer that mentions the same identifier three ways: in a sentence,
    // alone in backticks the way a model writes "Connector-ID: `…`", and inside
    // a payload. The first two must be named or masked; the third must survive
    // untouched. Monospace alone is not permission to print an identifier —
    // that is how one reached a running installation.
    //
    // Formerly: an answer that mentions the same identifier twice: once in a sentence,
    // where the reader needs the name, and once inside a payload, where the
    // identifier IS the answer and masking it hands the reader something that
    // cannot work. The fixture holds both because the display rule differs.
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
    // A whole turn as the engine actually persists one: a run of reads the
    // agent made to orient itself, then the calls that changed something.
    // Without this the sweep never photographed a tool card at all, which is
    // how every card in the product came to read the same three words unnoticed.
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
        tool: "search_knowledge_v2",
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
      // No result at all: the call the stream lost. It must read as unfinished
      // rather than as permanently running.
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

function operationalOverview() {
  const generatedAt = "2026-08-26T10:00:00.000Z";
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
        2,
        "/cockpit/decisions?bucket=blocked",
        "critical",
      ),
      overdue: overviewMetric(
        "decisions.overdue",
        3,
        "/cockpit/decisions?bucket=overdue",
        "urgent",
      ),
      other_decisions: overviewMetric("decisions.other", 7, "/cockpit/decisions?bucket=other"),
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

function sse(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `event: outcome\ndata: ${JSON.stringify(body)}\n\n`,
  });
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
        "api_key:rotate",
        "api_key:revoke",
        "settings:write",
        "self_healing:read",
        "self_healing:write",
      ],
      csrf_token: "test-csrf",
      version: "visual-sweep",
      recent_conversations: [],
    });
  }
  if (path === "/v1/operational-overview") return json(route, operationalOverview());
  if (path === "/v1/conversations" && request.method() === "GET") {
    // The status filter is answered, not ignored. It used to be: the decisions
    // page asks `?status=awaiting_input`, got all 32 conversations back with
    // `total: 32`, and photographed 32 positions waiting on an answer where the
    // fixture had built 11. Every frame of that surface overstated it, and the
    // number a person quoted from the screenshot was the fixture's length.
    const search = new URL(request.url()).searchParams;
    const status = search.get("status");
    // Nothing in this fixture is hidden, so the hidden view is empty — the
    // state that shows the empty line rather than a copy of the list.
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
      // One thing built and one thing run: the header lists both with links.
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
    });
  }
  if (path === `/v1/conversations/${uuid}/messages`)
    return sse(route, { conversation, status: "active" });
  if (path === `/v1/workflows/${uuid}/execution-authorities`)
    return json(route, { items: [], next_cursor: null });
  if (path === `/v1/workflows/${uuid}`)
    return json(route, {
      id: uuid,
      name: "Monatsreport",
      slug: "monatsreport",
      lifecycle: "active",
      current_version: 8,
      current_version_id: "018f4b4a-6d33-7b3a-9c2d-123456789ab8",
      steps: [
        { id: "fetch", name: "Daten laden", kind: "request" },
        { id: "transform", name: "Report berechnen", kind: "transform" },
      ],
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
      name: "Betriebshandbuch",
      status: "active",
      source_type: "file_upload",
      version: "knowledge-v4",
      updated_at: "2026-08-10T09:00:00.000Z",
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
      body: "# Sichere Reports\n\nVor externen Schreibzugriffen immer eine Freigabe einholen.",
      scope: "global",
      status: "active",
      maturity: "stable",
      version: 3,
      updated_at: "2026-08-10T09:00:00.000Z",
    });
  if (path === `/v1/files/${uuid}`)
    return json(route, {
      id: uuid,
      filename: "report-notes.md",
      status: "ready",
      content_type: "text/markdown",
      size_bytes: 1840,
      created_at: "2026-08-10T09:00:00.000Z",
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
    // Every list gets rows the pleasant path never produces: the awkward
    // lifecycle values, an unhealthy row, a name far past the column width,
    // an empty relation and an unmeasured size. A fixture that is uniformly
    // healthy photographs a console nobody operates.
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
          status: ["active", "draft", "archived", "active"][rotate],
          scope: ["global", "connector", "workflow", "global"][rotate],
          connector_id: rotate === 1 ? uuid : null,
          workflow_id: rotate === 2 ? uuid : null,
          side_effects: ["read", "write", "destructive", "none"][rotate],
          maturity: rotate === 1 ? "experimental" : "stable",
          version: 3,
          updated_at: conversation.updated_at,
        };
      return {
        filename: `report-notes-${index + 1}.md`,
        status: ["ready", "scanning", "failed", "expired"][rotate],
        scan_result: ["clean", "noop", "infected", "timeout"][rotate],
        content_type: "text/markdown",
        size_bytes: rotate === 2 ? null : 1840,
        created_at: conversation.updated_at,
      };
    };
    const items = Array.from({ length: 42 }, (_, index) => ({
      ...rowFor(index),
      id: index === 0 ? uuid : `catalog-record-${index}`,
    }));
    const categories =
      path === "/v1/workflows" || path === "/v1/connectors"
        ? [
            { category: "reporting", count: 21 },
            { category: "betrieb", count: 21 },
          ]
        : undefined;
    return json(route, {
      items,
      total: items.length,
      ...(categories ? { categories } : {}),
    });
  }
  if (path === "/v1/connections") {
    // One row per state the page words differently. A fixture that only ever
    // shows healthy grants proves nothing about the two that need a way back.
    return json(route, {
      items: [
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
          used_by_connectors: 2,
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
          used_by_connectors: 1,
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
          last_error: "invalid_grant",
          used_by_connectors: 3,
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
          used_by_connectors: 0,
          created_at: "2026-04-01T09:00:00.000Z",
        },
      ],
    });
  }
  if (path === "/v1/connections") {
    // One row per state the page words differently. A fixture that only ever
    // shows healthy grants proves nothing about the two that need a way back.
    const grant = (id, name, state, extra) => ({
      id,
      name,
      base_url: `https://${id}.example.com`,
      issuer: "https://login.example.com",
      service_name: name,
      service_description: null,
      scopes: ["reports.read"],
      granted_scopes: state === "valid" ? ["reports.read"] : null,
      state,
      auto_renew: state !== "expired",
      expires_at: null,
      last_used_at: null,
      last_refreshed_at: null,
      refresh_failed_at: null,
      last_error: null,
      used_by_connectors: 0,
      created_at: "2026-06-02T09:00:00.000Z",
      ...extra,
    });
    return json(route, {
      items: [
        grant("reporting", "Reporting-Portal", "valid", {
          expires_at: "2026-12-01T09:00:00.000Z",
          used_by_connectors: 2,
        }),
        grant("billing", "Abrechnung", "expiring", { expires_at: "2026-09-05T09:00:00.000Z" }),
        grant("mail", "Postfach", "expired", { last_error: "invalid_grant" }),
        grant("inventory", "Lager", "unreadable", {}),
      ],
    });
  }
  if (path === "/v1/executions") {
    // The run list has no duration field and no sort: an unfinished run, a
    // failed one and a child run all have to survive the sweep.
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
      };
    });
    return json(route, { items, total: 240, next_cursor: null });
  }
  if (path === "/v1/audit-log") {
    // Actions the engine ACTUALLY emits. The four this fixture used to rotate
    // through — workflow.update, connector.test, skill.archive, settings.write —
    // exist in no AuditAction: the sweep was photographing a log of verbs the
    // product cannot write, so no frame could ever show one of them named
    // wrongly, or named at all.
    //
    // `settings.changed` is left in on purpose as the one action the cockpit has
    // no word for: the honest fallback — the engine's own string — has to be
    // visible in a frame, or nobody notices it becoming "Unbekannt". It is the
    // ENGINE's spelling and not a plausible-looking one: the first version of
    // this list wrote `settings.updated`, which no `AuditAction` carries, so the
    // commit that removed four invented verbs shipped a fifth.
    const catalogue = AUDIT_FIXTURE_ROWS;
    // The engine filters on `action` and takes a comma-separated list. A mock
    // that ignored it would photograph a filter labelled "Entscheidungen" over
    // rows that are not decisions.
    const wanted = (new URL(request.url()).searchParams.get("action") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const rows = wanted.length
      ? catalogue.filter((entry) => wanted.includes(entry.action))
      : catalogue;
    const items = Array.from({ length: wanted.length ? rows.length * 4 : 24 }, (_, index) => {
      const row = rows[index % rows.length];
      return {
        id: index === 0 ? uuid : `audit-${index}`,
        ts: new Date(Date.parse(conversation.updated_at) - index * 120_000).toISOString(),
        tenant_id: uuid,
        actor_type: ["user", "system_account", "system", "user"][index % 4],
        actor_id: index % 4 === 2 ? null : uuid,
        action: row.action,
        resource_type: row.resource_type,
        resource_id: row.resource_type === "settings" ? null : uuid,
        result: row.result,
        trace_id: null,
        ip: null,
        user_agent: null,
        reason:
          row.result === "denied"
            ? "Rolle deckt skill:write nicht ab."
            : row.action === "skill_candidate.rejected"
              ? "Deckt sich mit einem schon freigegebenen Skill."
              : null,
        metadata: {},
      };
    });
    return json(route, { items, next_cursor: "audit-cursor-2" });
  }
  if (path === "/v1/notifications/inbox") {
    // A real inbox row: whether a person has to act, what it concerns, and
    // whether THIS person has read it. Deliberately mixed so a screenshot shows
    // the read and unread treatments side by side, and one row carries a
    // resource type the cockpit has no surface for — that must render as a word
    // rather than as a link to nowhere.
    const EVENTS = [
      ["execution.failed", true, "execution"],
      ["connector.auth_failed", true, "connector"],
      ["patch.proposed", true, "patch_candidate"],
      ["execution.succeeded", false, "execution"],
      ["workflow.updated", false, "workflow"],
      ["something.unmapped", false, null],
    ];
    // Honour the filters, or a screenshot shows "needs you" selected next to
    // rows that plainly do not.
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
  if (path === "/v1/stats/executions") {
    if (!url.searchParams.get("bucket") || !url.searchParams.get("from"))
      return json(route, { code: "validation", message: "request validation failed" }, 400);
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
    // Deliberately NOT all-clear. An all-clear fixture photographs the one
    // state that needs no design, and it also contradicted the decision
    // counter in the same screenshot. Failures carry both origins so the
    // trial-run split is visible, and one candidate is stuck.
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
          last_seen: "2026-08-10T08:40:00.000Z",
          cause: "Das angebundene System antwortet seit gestern mit einem Fehler.",
          guidance: "Zugangsdaten prüfen und den Lauf erneut anstoßen.",
        },
        {
          signature: "draft:transform:type_error",
          workflow_id: uuid,
          workflow_name: "Entwurf: Umsatzrollup",
          step_key: "transform",
          error_code: "type_error",
          origin: "authoring",
          count: 23,
          last_seen: "2026-08-10T08:10:00.000Z",
          cause: "Ein Testlauf beim Bauen ist an der Umwandlung gescheitert.",
          guidance: "",
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
  // "Vorbereitete Änderungen" on the settings page — a secret version somebody
  // prepared and nobody has approved yet. Added in 6.29.0 and never given a
  // fixture, so the generic list fallthrough at the bottom of this router
  // answered it with `{id, name, status, type, created_at}` rows: the section
  // then read `pending_since` (undefined → `dateTime` calls `.valueOf()` on it)
  // and `bindings.length`, and threw before the page mounted. The rows below
  // carry the real `PendingSecretVersion` shape
  // (`apps/engine/src/http/routes/secret-approvals.ts`).
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
  // How a connector authenticates — the card that names a connection or a
  // pasted key. Unmocked, the generic list fallthrough answered it with an
  // object that has no `updated_at`, and the card called `dateTime` on it.
  if (/^\/v1\/connectors\/[^/]+\/credential$/.test(path) && request.method() === "GET")
    return json(route, {
      mode: "connection",
      environment: "prod",
      connection: { id: "connection-valid", name: "Reporting-Portal" },
      updated_at: new Date(SWEEP_NOW - 6 * 3_600_000).toISOString(),
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
            { protocol: "api_key", id: "api-key", label: "SubKit API key" },
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
          path: "execution.default_timeout_ms",
          value: 30000,
          meta: {
            source: "default",
            scope: "tenant",
            sensitive: false,
            requiresRestart: false,
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
      ],
      diagnostics: { pending_restart_keys: [], override_keys: [] },
    });
  if (path === "/v1/identity/users")
    return json(route, {
      items: [
        {
          id: uuid,
          email: "operator@example.com",
          role: "admin",
          effective_role: "admin",
          role_consistent: true,
          status: "active",
        },
      ],
      // Declared by the settings response and read by the page; a fixture that
      // omits it renders a page that cannot mount.
      diagnostics: { pending_restart_keys: [], override_keys: [] },
    });
  if (path === "/v1/identity/api-keys")
    return json(route, {
      items: [
        {
          id: uuid,
          name: "Cockpit verification",
          prefix: "wf_live_demo",
          scopes: ["workflow:read", "workflow:run"],
          created_at: "2026-08-10T07:00:00.000Z",
          last_used_at: null,
          expires_at: null,
          revoked_at: null,
        },
      ],
      // Declared by the settings response; a fixture that omits it renders a
      // page that cannot mount.
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
      ],
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
          // The whole envelope the engine ships with the list. Every field here
          // was previously fetched and discarded.
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
          // A proactive candidate with no step snapshot — the one case where the
          // diff card says "this proposal changes nothing". It belongs in a
          // screenshot, not in production.
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
  if (path === "/v1/skill-candidates")
    return json(route, {
      total: 1,
      reviewable_total: 1,
      items: [
        {
          id: uuid,
          tenant_id: uuid,
          reviewable: true,
          review_reason: null,
          review_digest: "a".repeat(64),
          base_version_id: uuid,
          scope: "workflow",
          connector_id: null,
          workflow_id: uuid,
          endpoint_key: null,
          pattern_kind: "repair_pattern",
          title: "Umbenannte Antwortfelder zuerst prüfen",
          // The text approval would promote. Never rendered before this change.
          body: "Wenn ein Schritt plötzlich undefined liest, hat das System meist ein Feld verschoben statt es zu entfernen.\n\nErst die Antwortstruktur mit der aufgezeichneten vergleichen, dann den Pfad nachziehen — ein neuer Aufruf ist selten nötig.",
          examples: [`data.id wurde zu data.result.id (Lauf ${uuid})`],
          best_practices: ["Aufgezeichnete Antwort als Vergleich heranziehen"],
          pitfalls: ["Nicht den ganzen Schritt neu schreiben, nur den Pfad"],
          doc_refs: ["docs/concepts/self-healing.md"],
          evidence_count: 2,
          confidence: "high",
          status: "proposed",
          promoted_skill_id: null,
          fingerprint: "fp-1",
          version: 1,
          tags: ["domain:reporting"],
          created_at: new Date(SWEEP_NOW - 20 * 3_600_000).toISOString(),
          updated_at: new Date(SWEEP_NOW - 20 * 3_600_000).toISOString(),
        },
      ],
    });

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

function markerFor(route) {
  if (route === "chat") return '[data-testid="chat-workspace"]';
  if (route === "") return '[data-testid="overview-page"]';
  // Decisions owns its page rather than rendering a list of records.
  if (route === "decisions") return '[data-testid="decisions-page"]';
  // Installation surfaces name their frame after the section, not the record
  // type. Connections joined them without joining this list, and the sweep has
  // been waiting for a marker that is not on the page since.
  if (["people", "access", "api-access", "operations", "settings", "connections"].includes(route))
    return `[data-testid="admin-${route}"]`;
  // Connectors render through the shared catalog table like every other list.
  if (["workflows", "connectors", "knowledge", "skills", "files"].includes(route))
    return `[data-testid="catalog-${route}"]`;
  return `[data-testid="resource-${route}"]`;
}

function documentThemeMatches(classes, theme) {
  const dark = classes?.split(/\s+/).includes("dark") ?? false;
  return theme === "dark" ? dark : !dark;
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
  if (
    geometry.bodyHeight > geometry.viewportHeight + 1 ||
    geometry.contentBottom > geometry.viewportHeight + 1
  )
    throw new Error(`${label} grows beyond the viewport`);
}

async function assertChat(page, label) {
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
        .querySelector('[data-testid="chat-header"] > div')
        ?.getBoundingClientRect()
        .toJSON(),
      transcriptColumn: document
        .querySelector('[data-slot="message-scroller-content"]')
        ?.getBoundingClientRect()
        .toJSON(),
      scrollbars: {
        header: scrollbar('[data-testid="chat-header"]'),
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
  // The transcript owns the page now: a chat that gives its width to a
  // permanent list is the state this check exists to catch.
  if (layout.transcript.width < layout.main.width - 4)
    throw new Error(`${label} transcript does not span the conversation column`);
  if (Math.abs(layout.composer.height - 48) > 1)
    throw new Error(`${label} one-line composer is ${layout.composer.height}px, expected 48px`);
  if (
    Math.abs(layout.composerSubmit.width - 32) > 1 ||
    Math.abs(layout.composerSubmit.height - 32) > 1
  )
    throw new Error(`${label} composer submit control is not 32px square`);
  const submitRightInset = layout.composer.right - layout.composerSubmit.right;
  const submitBottomInset = layout.composer.bottom - layout.composerSubmit.bottom;
  if (Math.abs(submitRightInset - 8) > 1 || Math.abs(submitBottomInset - 8) > 1)
    throw new Error(`${label} composer submit control is not inset by 8px`);
  if (
    Math.abs(layout.inputStyle.paddingLeft - 16) > 1 ||
    Math.abs(layout.inputStyle.paddingTop - 11) > 1 ||
    Math.abs(layout.inputStyle.lineHeight - 24) > 1
  )
    throw new Error(`${label} composer input spacing is not 16px/11px with 24px leading`);
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
  await composerInput.fill("first line\nsecond line");
  const multiline = await page.evaluate(() => {
    const rect = (testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!(element instanceof HTMLElement)) throw new Error(`${testId} missing`);
      return element.getBoundingClientRect().toJSON();
    };
    return { composer: rect("chat-composer"), submit: rect("chat-composer-submit") };
  });
  if (multiline.composer.height <= 48) throw new Error(`${label} multiline composer did not grow`);
  if (Math.abs(multiline.composer.bottom - multiline.submit.bottom - 8) > 1)
    throw new Error(`${label} multiline submit control is not bottom-aligned`);
  await composerInput.fill("");
  const assistantMetadata = await page
    .locator('[data-testid="chat-message-1-metadata"]')
    .textContent();
  if (!assistantMetadata.includes("provider/model-v1"))
    throw new Error(`${label} assistant metadata is ${JSON.stringify(assistantMetadata)}`);
  // A payload keeps its identifier; a sentence must not. Both live in the
  // fixture above, so a rule that masks everything and a rule that masks
  // nothing each fail here.
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

/**
 * The conversation list opens on demand. Every check that reads a row has to
 * open it first — a closed panel yields an empty, green screenshot, which is
 * exactly the false pass these fixtures exist to prevent.
 */
async function openConversationList(page) {
  const list = page.locator('[data-testid="conversation-list"]');
  if (!(await list.isVisible())) {
    await page.locator('[data-testid="conversation-list-trigger"]').click();
    await list.waitFor({ state: "visible" });
  }
  // Visibility starts at the beginning of the 200 ms sheet transition. Wait
  // for its documented duration before clicking a moving row or close button.
  await page.waitForTimeout(250);
}

async function closeConversationList(page) {
  if (!(await page.locator('[data-testid="conversation-list"]').isVisible())) return;
  await page.locator('[data-testid="conversation-list-close"]').click();
  await page.locator('[data-testid="conversation-list"]').waitFor({ state: "hidden" });
}

/**
 * A page's content must start where its own heading starts.
 *
 * This shipped broken twice. First the scrollbar shifted a centred column
 * against its title; then the padding sat INSIDE the width cap in the body and
 * outside it in the header, indenting the content by exactly one padding step.
 * Both were found by looking at a screenshot, which is the wrong instrument —
 * a 32px offset is a measurement, so measure it.
 */
async function assertHeadingAlignment(page, label) {
  const offset = await page.evaluate(() => {
    const heading = document.querySelector("main h1");
    if (!heading) return null;
    // The first thing the body renders, whatever it is: a card, a table, a
    // paragraph. Its left edge is what a reader compares the title against.
    const body = document.querySelector(
      'main [data-testid$="-context"], main article, main [data-slot="table-container"], main section, main p',
    );
    if (!body) return null;
    const a = heading.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    if (b.width === 0 || b.top < a.bottom) return null;
    return Math.round(b.left - a.left);
  });
  // Null means the page has no heading or nothing below it to compare against.
  if (offset === null) return;
  if (Math.abs(offset) > 2) {
    throw new Error(`${label} indents its content ${offset}px against its own heading`);
  }
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
  if (callback !== "https://subkit.mikebild.info/v1/identity/login/callback") {
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

/**
 * A list of blank values is not a list.
 *
 * Found in a screenshot, which is the wrong instrument: the workflow detail read
 * „Läuft automatisch: , , , , , , , , , , , ," — thirteen empty entries joined
 * with commas, under a sentence claiming the workflow runs by itself. No run
 * reported it, because every rule this sweep had asked about layout, tables or
 * WORDS, and this surface had no words to show.
 *
 * The rule is about the SEPARATORS, not about any one field: two commas with
 * nothing between them, a label whose value begins with one, or a text that ends
 * on one — each means something was enumerated that had nothing to say.
 */
async function assertBlankLists(page, label) {
  const hits = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      // Code is exempt: a JSON line or a diff row legitimately ends on a comma,
      // and the rule is about PROSE that enumerates nothing.
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
        return [
          `${element.tagName.toLowerCase()}[${element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 32) || "unlabelled"}] ${element.outerHTML.slice(0, 180)}`,
        ];
      }),
    );
  if (missing.length) throw new Error(`${label} has interactives without data-testid: ${missing}`);
}

/**
 * Every frame this run wrote, counted where it is written.
 *
 * The closing line used to CALCULATE the number:
 * `routes * viewports * variants + variants * 12`. It reported 252 while the run
 * wrote 296 — the 12 was stale, and the four contact sheets per pass were in no
 * term of the formula at all. The count is not even a constant: the expanded
 * decision cards depend on which toggles a fixture exposes, so a hand formula
 * cannot be right for two runs in a row. That number was then quoted onwards as
 * a measurement.
 *
 * A number never travels without the rule that produced it, which is why the
 * line below says where this one comes from.
 */
let framesWritten = 0;
/**
 * Where every frame this run wrote is lying — by the label it was taken under.
 *
 * The contact sheets are built out of these files. They used to RECONSTRUCT the
 * file names, which meant a second place that knows how a frame is called; now
 * the name exists once, where the file was written.
 */
const written = new Map();

/**
 * The output directory, made ready at the moment of the first write.
 *
 * Emptied, not merely created: the closing line counts the frames of THIS run
 * against the files lying here, and a leftover from an earlier run would make
 * that comparison lie in the safe-looking direction.
 *
 * Made ready LATE, on the first frame, because it is now possible for the run to
 * be refused after it has started walking the routes. A refused run leaves no
 * directory behind and destroys no earlier one — "nothing was photographed" is
 * then true of the disk as well as of the sentence.
 */
let outputReady = false;
async function prepareOutput() {
  if (outputReady) return;
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  outputReady = true;
}

/**
 * A frame of a page THIS STAND NAMED, written under the name of the product
 * that answered on it.
 *
 * `stand.frameName` is where the run is authorised, and it authorises
 * constructively: a page that never went through `stand.visit()` has no product,
 * so there is no path, so `screenshot` is never reached. Nothing here has to
 * remember to check anything.
 */
async function shoot(page, label, options) {
  await prepareOutput();
  const path = resolve(outputDir, stand.frameName(page, label));
  await page.screenshot({ ...options, path });
  framesWritten += 1;
  written.set(label, path);
}

/**
 * A contact sheet: assembled from frames already on disk, named from the last
 * answer this stand gave. Counted like every other frame.
 */
async function shootSheet(page, label, options) {
  await prepareOutput();
  const path = resolve(outputDir, stand.sheetName(label));
  await page.screenshot({ ...options, path });
  framesWritten += 1;
  written.set(label, path);
}

/**
 * Whose console is being photographed — asked AT EVERY NAVIGATION.
 *
 * This script now SERVES what it photographs (see `startPreviewServer` above).
 * It used to point at whatever held `COCKPIT_BASE_URL`, and on its default port
 * a masterless process of a foreign session was listening for two days — twice.
 * The stand below still asks at every navigation, because a named target
 * (`COCKPIT_BASE_URL`) is still allowed, and because a product that answers is
 * not the same as the product this tree builds.
 *
 * The question used to be asked of the HTTP TEXT with a regex while the frames
 * came out of Chromium's parse. That was repaired to the browser — and the
 * repair still asked ONCE, on a page of its own, before the first frame. One
 * browser, but not the same page and not the same document: measured against a
 * stand that changes hands after its first answer, the sweep got 1 SubKit
 * answer and photographed 240 WorkKit documents, exit 0, 296 frames.
 *
 * `stand.visit()` is the only way to a page here, and it names what it opens.
 * The `readdir`-free promise this makes is stronger than a check: an
 * unauthorised page has no file name (`frameName`), so it cannot produce a
 * picture at all.
 */
const stand = standAt({
  baseUrl,
  refuse: (sentence, options) => new Error(`Cockpit visual sweep NOT TAKEN — ${sentence}`, options),
  hint: process.env.COCKPIT_BASE_URL
    ? "COCKPIT_BASE_URL names this port; build the cockpit and run a preview on it, or unset it and let the sweep serve its own build."
    : "The sweep started this preview itself over assets/cockpit — a foreign answer here means the port was taken between the probe and the bind.",
});

// BEFORE the browser starts, and before a single frame is produced: a sweep
// pointed at a fiction must cost milliseconds, not 296 screenshots.
assertAuditFixtureActionsAreReal();

const browser = await chromium.launch({ headless: true });
const errors = [];
const locales = [
  { name: "de", browser: "de-DE" },
  { name: "en", browser: "en-US" },
];
const variants = locales.flatMap((locale) =>
  ["light", "dark"].map((theme) => ({
    ...locale,
    theme,
    artifact: `${locale.name}-${theme}`,
  })),
);
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "wide", width: 1990, height: 1090 },
  { name: "mobile", width: 390, height: 844 },
];

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
    for (const route of routes) {
      const artifactRoute = route || "overview";
      // The door. Status and identity in one act, on the page that is about to
      // be photographed — not on a page of its own, and not once for the run.
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
      // Every list renders its failure as the table's own retry row, so one
      // selector covers all of them.
      await page
        .locator('[data-testid="data-table-retry"]')
        .waitFor({ state: "hidden" })
        .catch(() => {});
      for (const errorSelector of [
        '[data-testid="data-table-retry"]',
        '[data-testid="overview-error"]',
      ]) {
        if (
          await page
            .locator(errorSelector)
            .isVisible()
            .catch(() => false)
        )
          throw new Error(`${locale.artifact}/${viewport.name}/${route} displays a resource error`);
      }
      // An identifier is banned everywhere a person reads, with exactly one
      // exception: inside a fenced block, where it is not a label but the
      // content — a request body the answer is handing over. Masking it there
      // hands the reader something that cannot work. Everywhere else, including
      // a bare identifier set in backticks mid-sentence, it is still banned;
      // monospace is not permission.
      const text = await page.locator("body").innerText();
      const visibleText = await page.evaluate(() => {
        const body = document.body.cloneNode(true);
        for (const block of [...body.querySelectorAll("pre")]) block.remove();
        return body.innerText ?? "";
      });
      if (visibleText.includes(uuid))
        throw new Error(`${locale.artifact}/${viewport.name}/${route} exposes a UUID`);
      if ((await page.locator("html").getAttribute("lang")) !== locale.name)
        throw new Error(`${locale.artifact}/${viewport.name}/${route} uses the wrong locale`);
      if (!documentThemeMatches(await page.locator("html").getAttribute("class"), locale.theme))
        throw new Error(`${locale.artifact}/${viewport.name}/${route} uses the wrong theme`);
      await assertViewport(page, `${locale.artifact}/${viewport.name}/${route}`);
      await assertTables(page, `${locale.artifact}/${viewport.name}/${route}`);
      await assertHeadingAlignment(page, `${locale.artifact}/${viewport.name}/${route}`);
      await assertInteractiveSelectors(page, `${locale.artifact}/${viewport.name}/${route}`);
      await assertBlankLists(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route === "chat") await assertChat(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route === "settings")
        await assertAuthProviderSettings(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route === "access") {
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
      await shoot(page, `${locale.artifact}-${viewport.name}-${artifactRoute}`, {
        fullPage: false,
      });
    }
    await verifyWorkflowPreview(page, stand, uuid, locale.name);
    await verifyWorkflowAuthorities(page, stand, uuid, locale.name, (state) =>
      shoot(page, `${locale.artifact}-${viewport.name}-workflow-authority-${state}`, {
        fullPage: false,
      }),
    );
    await verifyDecisionLifecycle(page, stand, uuid, locale.name, (state) =>
      shoot(page, `${locale.artifact}-${viewport.name}-decisions-${state}`, { fullPage: false }),
    );
    if (viewport.name === "desktop") {
      for (const resource of ["workflows", "connectors", "knowledge", "skills", "files"]) {
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
      // The expanded decision card. The sweep only ever photographed collapsed
      // cards, which is how a surface that asks people to approve things they
      // cannot see stayed green through every frame this sweep took.
      await stand.visit(page, "decisions");
      let expandedCards = 0;
      for (const prefix of ["decision-deferred", "decision-aged"]) {
        // Two positions per section, because the three kinds expand to entirely
        // different panels and one of them is always second in its section.
        for (const position of [0, 1]) {
          const toggle = page.locator(`[data-testid="${prefix}-${position}-toggle"]`);
          if (!(await toggle.count())) continue;
          await toggle.first().scrollIntoViewIfNeeded();
          await toggle.first().click();
          await page
            .locator(`[data-testid="${prefix}-${position}-detail"]`)
            .waitFor({ state: "visible", timeout: 10_000 });
          await page.waitForTimeout(300);
          await shoot(page, `${locale.artifact}-desktop-${prefix}-${position}-expanded`, {
            fullPage: false,
          });
          expandedCards += 1;
        }
      }
      // Silence is not success: a loop that matched nothing would otherwise
      // report a green sweep for a surface it never opened.
      if (expandedCards === 0) {
        throw new Error(`${locale.artifact}: no decision card exposed an expand toggle`);
      }
      // §8.5: the queue has one stable ordering. Photograph its foot explicitly
      // because the ordinary viewport frame does not reach the audit exit.
      await stand.visit(page, "decisions");
      // What stands at the FOOT of the decisions page. There used to be
      // two shelves of settled work there; there is one sentence with one link
      // now, and a frame that stops at the viewport would show neither. This
      // console's frames are exactly as tall as the viewport — 1000 px — so the
      // foot needs a photograph of its own.
      await page.locator('[data-testid="decisions-history"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shoot(page, `${locale.artifact}-desktop-decisions-foot`, {
        fullPage: false,
      });

      // The other end of that link, opened the way the link opens it.
      await stand.visit(page, "audit?scope=decisions");
      await page.locator('[data-testid="resource-audit"]').waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await shoot(page, `${locale.artifact}-desktop-audit-decisions`, {
        fullPage: false,
      });

      await stand.visit(page, "chat");
      // The list is a panel now. Capture it open, with rows in it — a shot of
      // the closed page proves nothing about the list.
      await openConversationList(page);
      await page.locator('[data-testid="conversation-item-0"]').waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await shoot(page, `${locale.artifact}-desktop-chat-list`, {
        fullPage: false,
      });
      // The hidden view: empty here, because this fixture hides nothing.
      await page.locator('[data-testid="conversation-toggle-hidden"]').click();
      await page.locator('[data-testid="conversation-hidden-empty"]').waitFor({ state: "visible" });
      await shoot(page, `${locale.artifact}-desktop-chat-hidden`, {
        fullPage: false,
      });
      await page.locator('[data-testid="conversation-toggle-hidden"]').click();
      await closeConversationList(page);
      // "New" resets to the empty state — starter cards and the composer, no
      // dialog in between. It lives on the page, not inside the list, so the
      // panel has to be out of the way before the click.
      await page.locator('[data-testid="conversation-new"]').click();
      await page.locator('[data-testid="chat-empty"]').waitFor({ state: "visible" });
      const modePicker = page.locator('[data-testid="chat-permission-select"]');
      const defaultMode = locale.name === "de" ? "Systemstandard" : "System default";
      if (!(await modePicker.textContent())?.includes(defaultMode))
        throw new Error(`${locale.artifact}: new chat does not inherit the system mode`);
      await modePicker.click();
      await page
        .getByRole("option", {
          name: locale.name === "de" ? "Vor Änderungen fragen" : "Ask before changes",
          exact: true,
        })
        .click();
      if (
        !(await modePicker.textContent())?.includes(
          locale.name === "de" ? "Vor Änderungen fragen" : "Ask before changes",
        )
      )
        throw new Error(`${locale.artifact}: explicit conservative mode is not selectable`);
      await page.locator('[data-testid="conversation-new"]').click();
      if (!(await modePicker.textContent())?.includes(defaultMode))
        throw new Error(`${locale.artifact}: new chat retains an unintended override`);
      await page.waitForTimeout(300);
      await shoot(page, `${locale.artifact}-desktop-chat-new`, {
        fullPage: false,
      });
      await openConversationList(page);
      await page.locator('[data-testid="conversation-item-0"]').click();
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
      // The sheet leaves with an animation; the picker shot must not catch its tail.
      await page.locator('[data-testid="chat-context"]').waitFor({ state: "hidden" });
      // The @-picker, open with candidates from both catalogues.
      await page.locator('[data-testid="chat-composer-input"]').fill("Prüfe @mon");
      await page.locator('[data-testid="chat-mention-popover"]').waitFor({ state: "visible" });
      await page.locator('[data-testid="chat-mention-item-0"]').waitFor({ state: "visible" });
      await shoot(page, `${locale.artifact}-desktop-chat-mention`, {
        fullPage: false,
      });
      await page.keyboard.press("Escape");
      // A sent message with one resolved chip and one struck-through warning
      // chip: the transcript side of the same feature.
      const chips = page.locator('[data-testid="chat-message-2-text-0-mentions"]');
      await chips.scrollIntoViewIfNeeded();
      await page
        .locator('[data-testid="chat-message-2-text-0-chip-1"]')
        .waitFor({ state: "visible" });
      // The scroller renders lazily after a jump; give the frame its paint.
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
      await stand.visit(page, "usage");
      await page.locator('[data-testid="data-table-refresh"]').hover();
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

for (const locale of variants) {
  for (const viewport of ["desktop", "mobile"]) {
    const contact = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    });
    const cards = await Promise.all(
      routes.map(async (route) => {
        // Read back by the label the frame was WRITTEN under, not by a name
        // rebuilt here. A second place that knows how a frame is called is a
        // second place that can be wrong about it.
        const artifactRoute = route || "overview";
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
await browser.close();
spawnedPreview?.stop();
if (errors.length) throw new Error(errors.join("; "));
// The count, held against the effect it claims to describe.
//
// "Every frame goes through the counter" used to be a contract test over the
// source text, banning the string ".screenshot({". `await page.screenshot(opts)`
// — no brace — walked straight past it, 3/3 green, and the closing line would
// have understated the run again. A rule about how a call is SPELLED is not a
// rule about what was written; this one counts the files.
//
// FILES, and ALL of them. The line used to read ONE level and take every NAME
// ending in .png. Measured: four written frames, two of them one level down,
// next to a DIRECTORY called x.png — it answered 3, missing the two below and
// counting the directory. Both errors point the same way, towards a number that
// looks fine.
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
