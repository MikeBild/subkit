import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { AuditAction } from "../apps/engine/src/audit/types.ts";
import { verifyChatActivation } from "./lib/cockpit-chat-activation.mjs";
import { verifyChatActivity } from "./lib/cockpit-chat-activity.mjs";
import { verifyChatApprovals } from "./lib/cockpit-chat-approvals.mjs";
import { verifyChatChoices } from "./lib/cockpit-chat-choices.mjs";
import { verifyChatOAuth } from "./lib/cockpit-chat-oauth.mjs";
import { verifyChatReauth } from "./lib/cockpit-chat-reauth.mjs";
import { verifyChatReplies } from "./lib/cockpit-chat-replies.mjs";
import { verifyDecisionLifecycle } from "./lib/cockpit-decisions.mjs";
import { standAt } from "./lib/cockpit-identity.mjs";
import { verifyLoadFailures } from "./lib/cockpit-load-failures.mjs";
import { verifyScheduleHolds } from "./lib/cockpit-schedule-holds.mjs";
import { assertNoVisibleUuids } from "./lib/cockpit-visible-uuids.mjs";
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
// The run sheet's own record belongs to a workflow with NO open repair, so the
// remedy it offers is the one its cause asks for — a rejected sign-in leads to
// the connector — rather than the review the fixture's other workflow has
// waiting. Real-looking, and different from `uuid`: the identifier check finds
// shapes, not this one value.
const runWorkflowId = "5b2e9c14-7a3d-4f68-b1e0-8c9d2a4f6e37";
const runConnectorId = "c3a8f1d2-6b4e-4c97-a5f0-1e2d3b4c5a69";
const runVersionId = "9d4f6a21-3c8b-4e05-b7a2-6f1e0d9c8b34";
// A hostile authority for the workflow page: every identifier on it real and
// different, so a card that prints any of them fails the identifier check. The
// previous card printed its own UUID as its heading and passed, because the
// check only knew `uuid`.
const hostileAuthority = {
  id: "e7b1c4d9-2a6f-4b83-9c05-d3e8f1a2b4c6",
  workflow_version_id: "8a3d5f7b-1c9e-4d26-a0b8-f4e6c2d1a9b3",
  connector_id: "2f9e8d7c-6b5a-4f39-8e21-0d1c2b3a4f5e",
  created_by: "b6c5d4e3-f2a1-4098-8765-4a3b2c1d0e9f",
  tenant_id: "4c3b2a1f-0e9d-4c8b-9a76-5f4e3d2c1b0a",
};
const routes = [
  // The landing page was never photographed, which is how a whole class of
  // page-shell defect stayed invisible to this sweep.
  "",
  "decisions",
  // Each overview tile links here with its own bucket, and until now the sweep
  // only ever visited the bare page — so every narrowed view shipped
  // unphotographed, and three of the four buckets turned out not to narrow
  // anything at all. A tile that counts one thing and lands on another is the
  // defect this catches; it cannot be caught from the unnarrowed page.
  "decisions?bucket=blocked",
  "decisions?bucket=failing",
  "decisions?bucket=overdue",
  "decisions?bucket=other",
  "chat",
  "workflows",
  "runs",
  // One run, at its own address. The sheet used to open only from local list
  // state, so the frame that shows a single run's evidence — its boundary, its
  // stored approval, its steps, its result — was never taken. The route
  // shipped; nothing photographed it.
  `runs/${uuid}`,
  // The workflow's own page: health beside the title, the cause and its fix,
  // the latest runs, and the approval cards. It was only ever visited by the
  // authority stand, which checked none of it for identifiers.
  `workflows/${uuid}`,
  "connectors",
  // The connector-health component's own drilldown. Photographed narrowed,
  // because the fixture's healthy connectors are exactly what it must hide.
  "connectors?health=not_ok",
  "knowledge",
  "skills",
  "files",
  "audit",
  // The repair rate's drilldown: the decided repairs, by the engine's verbs.
  "audit?scope=all&action=patch_candidate.approved,patch_candidate.auto_applied,patch_candidate.rejected",
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
    // The pair that says what a decision actually changed. The engine has
    // always returned these two columns and the page dropped them, so no frame
    // could ever show a snapshot rendered wrongly — or rendered at all. This
    // row keeps its metadata EMPTY on purpose: `{}` must photograph as nothing,
    // not as an empty box under a heading.
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
    // Recorded details with nothing missing about them: a zero, a false and an
    // empty string are values the engine wrote down, and each one disappears
    // under a rendering rule that treats "empty" as "absent".
    metadata: { geaenderte_schritte: 2, wiederholungen: 0, benachrichtigt: false, hinweis: "" },
  },
  { action: "connector.invoked", resource_type: "connector", result: "denied" },
  {
    action: "settings.changed",
    resource_type: "settings",
    result: "error",
    // A change that never landed: there is a before and there is no after. One
    // block, and the sheet must not invent the second one.
    before: { aufbewahrung_tage: 30 },
  },
  // The one verb this build has NO word for, so the honest fallback — the
  // engine's own token in a machine face — appears in a frame. `settings.changed`
  // used to serve that purpose and has since been named, which would have left
  // the fallback unphotographed and free to rot back into "Weiterer Vorgang".
  // A real `AuditAction` (see `audit/types.ts`), not a plausible invention.
  {
    action: "mcp_oauth.client_registered",
    resource_type: "mcp_oauth_client",
    result: "success",
    // Performed by the engine, so the Operations view has something to show
    // and the Decisions view has something it legitimately leaves out.
    actor_type: "system",
    metadata: { anwendung: "Berichtsportal", zugriffsrechte: ["mcp:read"] },
  },
  // A schedule the engine put on hold. It belongs in a frame for two reasons:
  // it is the newest word the log has, and it is the only row whose `denied`
  // comes from a state change rather than a rejected call — a label that
  // quietly regressed to the raw `schedule.admission.changed` would otherwise
  // ship unphotographed.
  {
    action: "schedule.admission.changed",
    resource_type: "workflow_schedule",
    result: "denied",
    before: { zulassung: "erlaubt" },
    after: { zulassung: "angehalten" },
  },
  // The engine closing a repair it proved it cannot make. Written by the
  // system for every closure, so on a live tenant it is common — and a name
  // that regressed to the raw token would otherwise ship unphotographed.
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

/**
 * Every audit row this sweep can show, built ONCE.
 *
 * Actions the engine ACTUALLY emits. The four this fixture used to rotate
 * through — workflow.update, connector.test, skill.archive, settings.write —
 * exist in no AuditAction: the sweep was photographing a log of verbs the
 * product cannot write, so no frame could ever show one of them named wrongly,
 * or named at all.
 *
 * One row carries an action the cockpit has no word for, so the honest
 * fallback — the engine's own token, in a machine face — is visible in a frame.
 * Without it nobody notices the fallback rotting back into a phrase that claims
 * the log recorded something indistinct.
 *
 * The list answers from this array and so does the single-entry fetch the
 * detail sheet makes. A second builder there would let the sheet photograph a
 * record the list never had — the row saying one verb and the sheet another,
 * each frame looking correct on its own.
 */
const AUDIT_FIXTURE_ENTRIES = Array.from({ length: 24 }, (_, index) => {
  const row = AUDIT_FIXTURE_ROWS[index % AUDIT_FIXTURE_ROWS.length];
  return {
    id: index === 0 ? uuid : `audit-${index}`,
    ts: new Date(Date.parse(conversation.updated_at) - index * 120_000).toISOString(),
    tenant_id: uuid,
    // The row's own actor when it declares one, so the Operations filter and
    // the Akteur column cannot disagree — a view filtered to the engine must
    // not print "Person".
    actor_type: row.actor_type ?? ["user", "system_account", "system", "user"][index % 4],
    actor_id: index % 4 === 2 ? null : uuid,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_type === "settings" ? null : uuid,
    result: row.result,
    // Written on most rows and absent on a third of them, deliberately. The
    // detail sheet says so in words where the engine recorded nothing, and a
    // fixture in which every one of these is null photographs only the half of
    // that rule that prints a dash.
    trace_id: index % 3 === 0 ? null : `cli-949cacce25ff43${70 + (index % 10)}`,
    ip: index % 3 === 0 ? null : "203.0.113.42",
    user_agent: index % 3 === 0 ? null : "SubKit-CLI (macOS)",
    reason:
      row.result === "denied"
        ? "Rolle deckt skill:write nicht ab."
        : row.action === "skill_candidate.rejected"
          ? "Deckt sich mit einem schon freigegebenen Skill."
          : null,
    // What the table never showed. `before`/`after` are absent unless the row
    // records them, and `metadata` defaults to the empty object that most rows
    // genuinely carry — the shape that must render as nothing at all.
    before: row.before ?? null,
    after: row.after ?? null,
    metadata: row.metadata ?? {},
  };
});

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

function overviewMetric(id, value, path, severity = "information", kind = "count") {
  return {
    id,
    value,
    value_state: value === 0 ? "zero" : "observed",
    severity,
    kind,
    unit: kind === "ratio" ? "ratio" : "count",
    drilldown: { path },
  };
}

function operationalOverview() {
  const generatedAt = "2026-08-26T10:00:00.000Z";
  return {
    schema_version: "operational-overview.v1",
    contract_version: "2.3",
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
      // Non-zero on purpose: a tile that only ever renders its empty state is
      // photographed 700 times without anyone seeing what it looks like when it
      // has something to say.
      failing: overviewMetric(
        "decisions.failing",
        2,
        "/cockpit/decisions?bucket=failing",
        "urgent",
      ),
      overdue: overviewMetric(
        "decisions.overdue",
        3,
        "/cockpit/decisions?bucket=overdue",
        "urgent",
      ),
      other_decisions: overviewMetric("decisions.other", 7, "/cockpit/decisions?bucket=other"),
      // Hostile on purpose, and consistent with the tiles above: two blocked
      // workflows make the engine's score critical and aim it at the blocked
      // list; a connector needing re-auth sits among healthy ones; the drift
      // scan has not run for a day, so the numbers behind the page are stale.
      // A fixture that is healthy here photographs a system page with nothing
      // on it, which is exactly the frame that cannot show a missing cause.
      health: {
        ...overviewMetric(
          "operations.health",
          41,
          "/cockpit/decisions?bucket=blocked",
          "critical",
          "score",
        ),
        state: "critical",
        components: [
          {
            id: "decisions.blocked",
            raw_value: 2,
            unit: "count",
            normalized_score: 0,
            weight: 0.5,
            contribution: 0,
            freshness: "fresh",
            required: true,
            drilldown: {
              path: "/cockpit/decisions?bucket=blocked",
              label_id: "operational.open_blocked",
            },
          },
          {
            id: "executions.success_ratio",
            raw_value: 0.9375,
            unit: "ratio",
            normalized_score: 93.75,
            weight: 0.3,
            contribution: 28.125,
            freshness: "fresh",
            required: true,
            drilldown: {
              path: "/cockpit/runs?status=failed&source=scheduler",
              label_id: "operational.open_runs",
            },
          },
          {
            id: "connectors.healthy_ratio",
            raw_value: 0.8,
            unit: "ratio",
            normalized_score: 80,
            weight: 0.2,
            contribution: 16,
            freshness: "fresh",
            required: true,
            drilldown: {
              path: "/cockpit/connectors?health=not_ok",
              label_id: "operational.open_connectors",
            },
          },
        ],
        causes: [
          {
            kind: "held_schedule",
            id: uuid,
            label: "Monatsreport: automatic runs held for review",
            subject: { kind: "workflow", id: uuid, name: "Monatsreport" },
            reason: "held_for_review",
            detail: null,
            cause_class: null,
            drilldown: {
              path: "/cockpit/decisions?bucket=blocked",
              label_id: "operational.open_blocked",
            },
          },
          {
            kind: "connector",
            id: uuid,
            label: "Mailer: needs reauth",
            subject: { kind: "connector", id: uuid, name: "Mailer" },
            reason: "needs_reauth",
            detail: "Token refresh rejected by the provider.",
            cause_class: null,
            drilldown: {
              path: `/cockpit/connectors/${uuid}`,
              label_id: "operational.open_connector",
            },
          },
        ],
      },
      data_freshness: {
        ...overviewMetric(
          "data.freshness",
          90_000,
          "/cockpit/audit?scope=operations",
          "critical",
          "duration",
        ),
        value_state: "stale",
        state: "stale",
        sources: [
          {
            id: "self_healing.drift_scan",
            updated_at: "2026-08-25T09:00:00.000Z",
            expected_interval_seconds: 3600,
            stale_after_seconds: 7200,
            state: "stale",
            drilldown: {
              path: "/cockpit/audit?scope=operations",
              label_id: "operational.open_scans",
            },
          },
          {
            id: "connectors.reauth_scan",
            updated_at: generatedAt,
            expected_interval_seconds: 3600,
            stale_after_seconds: 7200,
            state: "fresh",
            drilldown: { path: "/cockpit/connectors", label_id: "operational.open_connectors" },
          },
        ],
      },
    },
    // The four sections and eight metrics a running installation serves.
    //
    // This used to be one section holding one tile. Seven of the eight metric
    // ids the page knows how to label were therefore never photographed, in
    // any language, at any width — and neither was the `progress`
    // visualization, a whole rendering branch. Eight hundred green screenshots
    // of a page showing a single tile say nothing about the page people open.
    //
    // It also swallowed a change made to this very file's subject: the only
    // metric whose drilldown still renders a link is `executions.incidents_24h`
    // (the rest lead to a list that cannot answer for the number). Absent from
    // the fixture, that link was photographed zero times. A fixture that omits
    // what the code singles out cannot see whether it works.
    //
    // Values are chosen to be awkward rather than tidy: a ratio that is not a
    // round number, a long repeating decimal, a zero beside a non-zero in the
    // same row, and an incident count high enough to render the link and its
    // urgent state.
    sections: [
      {
        id: "workflows",
        title: "Workflows",
        visualization: "kpi",
        metrics: [
          overviewMetric("automation.active_workflows", 91, "/cockpit/workflows"),
          overviewMetric("executions.total_24h", 36, "/cockpit/runs"),
        ],
        drilldown: { path: "/cockpit/workflows" },
      },
      {
        id: "reliability",
        title: "Reliability",
        visualization: "kpi",
        metrics: [
          overviewMetric("executions.success_ratio", 0.9375, "/cockpit/runs", "healthy", "ratio"),
          // Any production incident at all is `critical` to the engine, not a
          // graded band — so a non-zero count here is the severity it ships.
          // The path is the engine's own, both halves: this is the only metric
          // that still renders a link, and a fixture carrying a different one
          // photographs a link the product does not have.
          overviewMetric(
            "executions.incidents_24h",
            3,
            "/cockpit/runs?status=failed&source=scheduler",
            "critical",
          ),
          overviewMetric("executions.trial_failures_24h", 0, "/cockpit/runs?status=failed"),
        ],
        drilldown: { path: "/cockpit/runs" },
      },
      {
        id: "connections",
        title: "Connections",
        visualization: "progress",
        metrics: [
          // 0.8 is the engine's `urgent` band for this metric (>= 0.7, < 0.9).
          // Taken from the rule rather than picked, so the fixture cannot
          // photograph a severity the product never emits at this value.
          overviewMetric("connectors.healthy_ratio", 0.8, "/cockpit/connectors", "urgent", "ratio"),
        ],
        drilldown: { path: "/cockpit/connectors" },
      },
      {
        id: "learning",
        title: "Learning",
        visualization: "kpi",
        metrics: [
          overviewMetric(
            "repairs.applied_ratio",
            0.654320987654321,
            "/cockpit/audit?scope=all&action=patch_candidate.approved,patch_candidate.auto_applied,patch_candidate.rejected",
            "information",
            "ratio",
          ),
          overviewMetric("skills.reusable", 49, "/cockpit/skills"),
        ],
        drilldown: { path: "/cockpit/skills" },
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
  if (/^\/v1\/workflows\/[^/]+\/automation-status$/.test(path))
    return json(route, { schedules: [] });
  if (path === "/v1/schedules") return json(route, { schedules: [], total: 0 });
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
      // Unhealthy, with the engine's own English reason: the page has to say
      // the cause in its own words and keep this one behind "Wortlaut der
      // Engine", and offer the way to the fix.
      health_state: "degraded",
      health_reason: "3 consecutive scheduled runs failed",
      health_changed_at: "2026-08-10T08:00:00.000Z",
      updated_at: "2026-08-10T09:00:00.000Z",
    });
  // The connector the run sheet's failed step called. It reports its own
  // sign-in as gone, which is what earns "Neu anmelden" — the rejected request
  // alone does not (a 403 may be a missing scope).
  if (path === `/v1/connectors/${runConnectorId}`)
    return json(route, {
      id: runConnectorId,
      display_name: "Berichtsablage",
      slug: "berichtsablage",
      driver: "http",
      environment: "prod",
      enabled: true,
      auth_type: "oauth2",
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
    // `health=not_ok` is answered by the engine (enabled and not ok), with a
    // total of the narrowed list — the mock does the same.
    const narrowed = path === "/v1/connectors" && url.searchParams.get("health") === "not_ok";
    const items = Array.from({ length: 42 }, (_, index) => ({
      ...rowFor(index),
      id: index === 0 ? uuid : `catalog-record-${index}`,
    })).filter((row) => !narrowed || (row.enabled === true && row.health_state !== "ok"));
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
        // The cause group a failed row carries (§3). A timed-out run's class is
        // one this build has no word for, so the list must set it as the
        // engine's value — never as "Unbekannt".
        failure:
          rotate === 2
            ? { step_key: "write_products", cause_class: "auth_failed" }
            : rotate === 3
              ? { step_key: null, cause_class: "timeout" }
              : null,
      };
    });
    // The workflow page asks for the newest failed run and for the newest
    // five; a mock that ignored both answered "24 runs" to "the latest five".
    const status = url.searchParams.get("status");
    const limit = Number(url.searchParams.get("limit") ?? "0");
    const narrowed = status ? items.filter((item) => item.status === status) : items;
    return json(route, {
      items: limit > 0 ? narrowed.slice(0, limit) : narrowed,
      total: status ? narrowed.length : 240,
      next_cursor: null,
    });
  }
  // One run, by id. Without this the sheet's refresh fell through to the
  // catch-all `{ items: [] }` at the foot of this function — a 200 with no
  // `status` — and the page died on the status label before the sheet could
  // mount. The cockpit now refuses an answer that is not an execution, and
  // this route makes the sweep exercise the path that actually ships rather
  // than only the refusal.
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
      // The engine's verdict: which step stopped the run, and why, as a class.
      // The sheet composes its sentence from this, never from the English
      // message the step stored.
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
  // The steps of one run. Until this existed the sheet's own address fell
  // through to the catch-all `{ items: [] }` — so the run detail photographed
  // as a record with no steps, no error and no result, and no defect in how
  // any of the three is RENDERED could appear in the frame.
  //
  // The shapes below are the ones production actually stores, not tidy ones:
  //
  //   `result_preview` is a TEXT column holding a JSON serialisation, so a
  //   step that produced nothing stores the four characters `null` while
  //   `output_preview` (jsonb) is SQL NULL beside it. The sheet read
  //   `output_preview ?? result_preview`, the coalesce skipped the empty jsonb
  //   and the word `null` was printed under the heading "Ergebnis".
  //
  // The last step carries exactly that pair. A frame that shows `null` as a
  // result is the finding.
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
          // An empty object is a measured emptiness and must photograph as
          // such — not as a blank panel under a heading.
          output_preview: {},
          result_preview: null,
        },
        {
          step_key: "write_products",
          step_index: 2,
          status: "failed",
          duration_ms: 69,
          // Which connector the step called — the sign-in remedy leads there.
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
          },
          output_preview: null,
          result_preview: "null",
        },
      ],
      next_cursor: null,
    });
  }
  if (path === "/v1/audit-log") {
    // The engine filters on `action` and takes a comma-separated list. A mock
    // that ignored it would photograph a filter labelled "Entscheidungen" over
    // rows that are not decisions.
    const wanted = (url.searchParams.get("action") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    // `actor_type` is the other axis: the Operations view asks the engine for
    // its own housekeeping rather than sieving a page client-side. A mock that
    // ignored it would photograph a view labelled "Betrieb" over rows a person
    // performed.
    //
    // Sieved on the field the row RENDERS. The old filter read the catalogue
    // entry behind the row instead, so a row printing "Engine" in the Akteur
    // column was missing from the very view that claims to list exactly those.
    const actorType = url.searchParams.get("actor_type");
    const byAction = wanted.length
      ? AUDIT_FIXTURE_ENTRIES.filter((entry) => wanted.includes(entry.action))
      : AUDIT_FIXTURE_ENTRIES;
    const items = actorType ? byAction.filter((entry) => entry.actor_type === actorType) : byAction;
    return json(route, { items, next_cursor: "audit-cursor-2" });
  }
  // The one entry the detail sheet asks for, answered from the same array the
  // list answered with. An id this fixture does not know is a 404 and not a
  // cheerful stand-in: the catch-all at the foot of this function answers every
  // unmatched path with `{ items: [] }` and a 200, and a sheet that accepted
  // that would print an empty record the engine never wrote.
  const auditEntryPath = /^\/v1\/audit-log\/([^/]+)$/.exec(path);
  if (auditEntryPath) {
    const id = decodeURIComponent(auditEntryPath[1]);
    const entry = AUDIT_FIXTURE_ENTRIES.find((candidate) => candidate.id === id);
    return entry
      ? json(route, entry)
      : json(route, { error: { code: "not_found", message: "audit_entry" } }, 404);
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
  // Consumption — the half of the Usage page that measures spend.
  //
  // Deliberately awkward. The cap sits at 92 % so the "nearly exhausted"
  // badge renders rather than the comfortable one nobody needs to see; one
  // group consumed nothing, so the share column must show a dash and not
  // "0 %"; and one workflow name is long enough to test the truncation that
  // a tidy fixture would never reach.
  // A run's own consumption. Awkward on purpose: a cache share that is not a
  // round number, and a metered external cost small enough to need four
  // decimals — a tidy fixture would photograph neither.
  if (/^\/v1\/executions\/[^/]+\/cost$/.test(path)) {
    return json(route, {
      llm: {
        calls: 7,
        weighted_tokens: 58_472,
        prompt_tokens: 61_400,
        completion_tokens: 812,
        cache_read_tokens: 38_100,
        // 0–100, the shape `cost.ts` actually emits — a ratio here let the
        // page's unit guess photograph only its safe branch.
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
      tokens_month: 138_000_000,
      monthly_budget_tokens: 150_000_000,
      remaining_monthly_budget_tokens: 12_000_000,
      llm_provider: { configured: true, reachable: true },
    });
  }
  if (path === "/v1/stats/llm") {
    if (!url.searchParams.get("bucket") || !url.searchParams.get("from"))
      return json(route, { code: "validation", message: "request validation failed" }, 400);
    const axis = url.searchParams.get("group_by") ?? "workflow";
    const byAxis = {
      workflow: [
        ["mission-control-reporting-rollup-monthly-with-a-very-long-name", 812, 96_400_000],
        ["ga4-daily-report", 240, 31_600_000],
        ["radar-publish-weekly", 61, 10_000_000],
        // Consumption nothing can be attributed to, which on a real
        // installation is most of it: every call without a run has no
        // workflow. The row must be visible and named, not dropped.
        ["", 611, 74_000_000],
      ],
      flow: [
        ["converse", 690, 88_000_000],
        ["generate", 210, 34_000_000],
        ["judge", 180, 12_000_000],
        ["repair", 33, 4_000_000],
      ],
      // Keyed by `llm_usage.user_id`, which is a UUID or NULL — never an
      // address. Sending readable names meant the sweep never exercised the
      // UUID-to-name resolution, which is the only reason that lookup exists.
      user: [
        ["465c1424-676e-44c4-8ec0-7ff754f167b4", 900, 120_000_000],
        ["b221a085-3c6f-49e1-8553-3298949ab4db", 223, 18_000_000],
      ],
      model: [
        ["claude-sonnet-4-6", 820, 104_000_000],
        ["claude-haiku-4-5", 303, 34_000_000],
      ],
    };
    const rows = byAxis[axis] ?? byAxis.workflow;
    return json(route, {
      bucket: "day",
      tz: "UTC",
      from: "2026-07-11T00:00:00.000Z",
      to: "2026-08-10T00:00:00.000Z",
      groups: rows.map(([key, calls, total]) => ({
        // The PUBLISHED shape: a map of dimension to value. This fixture used
        // to send a bare string, which is what the page assumed — so the sweep
        // photographed a table that could never fill on a real installation.
        key: { [axis]: key },
        buckets: [],
        totals: {
          // PER GROUP this is a plain number; only the envelope-level total is
          // `{ total, by_result }`. The fixture sent the envelope shape — the
          // exact defect already fixed in the page — so every photographed row
          // rendered "0 calls" beside ninety-six million tokens and the sweep
          // passed, because a screenshot gate asserts that pixels exist.
          calls,
          tokens: { prompt: total, completion: 0, cache_read: 0, cache_creation: 0, total },
          latency_ms: { total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
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
      // PARTLY priced on purpose. A fully priced window would photograph an
      // amount that looks complete and never show the line that says what it
      // leaves out — which is the whole point of carrying `unpriced_*`.
      cost: {
        amount: 412.87,
        currency: "EUR",
        unpriced_models: ["some-new-model"],
        unpriced_calls: 47,
        rates_basis: "current",
      },
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
          scheduled_count: 14,
          last_seen: "2026-08-10T08:40:00.000Z",
          cause: "Das angebundene System antwortet seit gestern mit einem Fehler.",
          guidance: "Zugangsdaten prüfen und den Lauf erneut anstoßen.",
          resolved_at: null,
        },
        {
          // A scheduled cause that has ENDED — the workflow has run clean on
          // its schedule since. Served so a frame exists in which a recovered
          // failure is visibly not an open decision. Without it, the surface
          // that stops counting it is never photographed, and the split
          // between "still failing" and "fixed" ships unseen.
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
  // Asked for one workflow's open repair, the answer is that workflow's — the
  // run sheet's workflow has none, so its remedy is the one its cause asks for.
  if (path === "/v1/patch-candidates" && url.searchParams.get("workflow_id") === runWorkflowId)
    return json(route, { total: 0, reviewable_total: 0, items: [] });
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

/**
 * What a route's frame is called on disk. ONE place, because the file that
 * writes a frame and the file that looks it up disagreeing is how a sheet ends
 * up built from nothing — and the comment beside the second copy said exactly
 * that before it happened.
 */
function artifactRouteName(route) {
  // A parameterised route carries a slash, and a slash in an artifact name is
  // a directory that does not exist. The record's id is not part of the name:
  // the frame is of the DETAIL surface, and a second id would make two names
  // for one photograph.
  //
  // `-record`, not `-detail`: the catalog pass below photographs every detail
  // page as `<resource>-detail` on desktop. When the workflow page joined this
  // route list it was written under the same name, overwrote that frame in all
  // four desktop variants, and the run ended with 860 frames counted and 856
  // files on disk — correctly suspicious, with the wrong guess about why.
  const [path, query] = (route || "overview").split("?");
  const name = path.replace(/\/[^/]+$/, "-record");
  // A query becomes part of the name, so two narrowings of one page are two
  // frames rather than one overwriting the other (`decisions-bucket-failing`).
  return query ? `${name}-${query.replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "")}` : name;
}

function markerFor(route) {
  // A route may carry the bucket a tile linked with; the page it renders is the
  // same page.
  const path = route.split("?")[0];
  // A run's own address renders the list AND the sheet for that run. Waiting
  // on the list marker would photograph the page before the record arrived,
  // which is the frame that proves nothing.
  if (/^runs\/.+/.test(path)) return '[data-testid="run-detail-facts"]';
  if (/^workflows\/.+/.test(path)) return '[data-testid="workflow-recent-runs"]';
  if (path === "chat") return '[data-testid="chat-workspace"]';
  if (path === "") return '[data-testid="overview-page"]';
  // Decisions owns its page rather than rendering a list of records.
  if (path === "decisions") return '[data-testid="decisions-page"]';
  // Installation surfaces name their frame after the section, not the record
  // type. Connections joined them without joining this list, and the sweep has
  // been waiting for a marker that is not on the page since.
  if (["people", "access", "api-access", "operations", "settings", "connections"].includes(path))
    return `[data-testid="admin-${path}"]`;
  // Connectors render through the shared catalog table like every other list.
  if (["workflows", "connectors", "knowledge", "skills", "files"].includes(path))
    return `[data-testid="catalog-${path}"]`;
  return `[data-testid="resource-${path}"]`;
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

/**
 * One run's sheet, opened at its own address.
 *
 * Two things this frame has to prove, and both of them were true on the
 * running product before they were true here.
 *
 * The address itself: a run reached by URL must render THAT run's evidence.
 * Before the route existed every `/runs/<id>` landed on "page not found", so
 * no audit row, decision or metric could point at a single run.
 *
 * And the result: the steps fixture ends with the pair production stores for a
 * step that produced nothing — `output_preview` absent, `result_preview` the
 * four characters `null`. The sheet printed that word under the heading
 * "Ergebnis". A machine value rendered as prose is the shape §2 bans, and a
 * screenshot of it is only evidence if something reads the frame.
 */
/**
 * Enter on a row's "Öffnen" opens the record ONCE.
 *
 * The key bubbled from the button to the row, which opened the record, and
 * the browser then turned the same Enter into the button's click, which
 * opened it again: two history entries for one intent, and Back had to be
 * pressed twice to leave the sheet. It only shows through the keyboard, so
 * no screenshot and no model test could see it.
 *
 * Restores what it changed — Back closes the sheet and the list is checked
 * again — because a scenario that leaves a dialog open poisons a later stand.
 */
async function assertOpenOnce(page, label) {
  const open = page.locator('[data-testid="data-table-open-0"]');
  if (!(await open.isVisible().catch(() => false))) return;
  const before = await page.evaluate(() => window.history.length);
  await open.focus();
  await page.keyboard.press("Enter");
  await page.locator('[data-testid="run-detail-facts"]').waitFor({ state: "visible" });
  const after = await page.evaluate(() => window.history.length);
  if (after - before !== 1)
    throw new Error(
      `${label}: Enter on "Öffnen" added ${after - before} history entries — the record opened more than once`,
    );
  await page.goBack();
  await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
}

/**
 * The system page names what makes the installation red, each with its way in.
 *
 * It used to hold a scan button and a sentence saying its findings were on the
 * overview — while the overview's red health tile linked here. The hostile
 * snapshot carries a critical score, two causes and a stale source, so every
 * one of them must be a line, and the causes must lead where they are fixed.
 */
async function assertOperationsNamesItsCauses(page, label) {
  const block = page.locator('[data-testid="operations-attention"]');
  try {
    await block.waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    throw new Error(`${label}: a critical snapshot with causes shows no attention block`, {
      cause: error,
    });
  }
  const links = await block
    .locator('a[data-testid^="operations-attention-link-"]')
    .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href")));
  for (const expected of ["/cockpit/decisions?bucket=blocked", "/cockpit/audit?scope=operations"]) {
    if (!links.includes(expected))
      throw new Error(
        `${label}: no attention line leads to ${expected} (links: ${links.join(", ")})`,
      );
  }
  if (links.some((href) => href?.startsWith("/cockpit/cockpit")))
    throw new Error(`${label}: an attention link carries the base twice`);
  const text = await block.innerText();
  if (!text.includes("Mailer")) throw new Error(`${label}: the connector cause is not named`);
  // The engine's `label` is English prose; the page words the cause itself
  // from `subject` + `reason`, in either language.
  for (const engineLabel of ["Mailer: needs reauth", "automatic runs held for review"])
    if (text.includes(engineLabel))
      throw new Error(`${label}: the engine's sentence "${engineLabel}" is shown as the page's`);
  // The free text the engine wrote is kept — on its own line, as the engine's.
  const wording = await block
    .locator('[data-testid^="operations-attention-engine-wording-"]')
    .allInnerTexts();
  if (!wording.some((line) => line.includes("Token refresh rejected by the provider.")))
    throw new Error(`${label}: the engine's detail is not shown as the engine's wording`);
}

/**
 * The same page with nothing wrong says nothing — no "all good" card.
 *
 * Swaps the snapshot for a healthy one and restores it in `finally`: a
 * scenario that leaves its route behind poisons every frame after it.
 */
async function verifyHealthyOperationsIsQuiet(page, label) {
  const pattern = "**/v1/operational-overview*";
  const healthy = (route) => {
    const data = operationalOverview();
    Object.assign(data.core.blocked, { value: 0, value_state: "zero", severity: "healthy" });
    Object.assign(data.core.health, {
      value: 100,
      state: "healthy",
      severity: "healthy",
      causes: [],
      components: data.core.health.components.map((component) => ({
        ...component,
        raw_value: component.unit === "count" ? 0 : 1,
        normalized_score: 100,
      })),
    });
    Object.assign(data.core.data_freshness, {
      value: 0,
      value_state: "zero",
      state: "fresh",
      severity: "healthy",
      sources: data.core.data_freshness.sources.map((source) => ({
        ...source,
        updated_at: data.generated_at,
        state: "fresh",
      })),
    });
    return route.fulfill({ json: data });
  };
  await page.route(pattern, healthy);
  try {
    await stand.visit(page, "operations");
    await page.locator('[data-testid="operations-health"]').waitFor({ state: "visible" });
    if (await page.locator('[data-testid="operations-attention"]').count())
      throw new Error(`${label}: a healthy installation still shows an attention block`);
  } finally {
    await page.unroute(pattern, healthy);
  }
}

/** `?health=not_ok` lists the enabled connectors that are not ok, and says so. */
async function assertUnhealthyConnectorsOnly(page, label) {
  if (!(await page.locator('[data-testid="catalog-health-filter"]').isVisible()))
    throw new Error(`${label}: the health narrowing is not shown as a removable chip`);
  // The table body of THIS page. `main` matched both the shell and the page
  // frame; and the whole page would let a name in a chip or a heading satisfy
  // a check that is about which rows are listed.
  const rows = await page.locator('[data-testid="catalog-connectors"] tbody').innerText();
  // The fixture rotates Reporting API (ok), Mailer (needs re-auth), Warehouse
  // (disabled) and Legacy CRM (degraded). Only the two unhealthy enabled ones
  // count against the health score, so only they may be listed.
  for (const shown of ["Mailer", "Legacy CRM"])
    if (!rows.includes(shown)) throw new Error(`${label}: ${shown} is unhealthy and missing`);
  for (const hidden of ["Reporting API", "Warehouse"])
    if (rows.includes(hidden)) throw new Error(`${label}: ${hidden} is listed but not unhealthy`);
}

/** A link that names the log's verbs arrives as a chip the reader can lift. */
async function assertAuditActionChip(page, label) {
  if (!(await page.locator('[data-testid="audit-action-filter"]').isVisible()))
    throw new Error(`${label}: the verbs the link narrowed to are not shown as a chip`);
}

async function assertRunDetail(page, label, language) {
  const facts = page.locator('[data-testid="run-detail-facts"]');
  if (!(await facts.isVisible()))
    throw new Error(`${label} opened no run sheet — the address rendered the bare list`);
  // The title is the workflow, and leads there.
  const titleLink = page.locator('[data-testid="run-detail-workflow-link"]');
  await titleLink.waitFor();
  const titleHref = await titleLink.getAttribute("href");
  if (titleHref !== `/cockpit/workflows/${runWorkflowId}`)
    throw new Error(`${label} run title leads to ${titleHref}, not to its workflow`);
  // The verdict, as the cockpit's sentence composed from the engine's outcome.
  const outcome = page.locator('[data-testid="run-detail-outcome"]');
  await outcome.waitFor();
  const sentence = (await outcome.innerText()).trim();
  const expected =
    language === "de"
      ? "Abgebrochen bei Schritt „write_products“ – Ursache: Anmeldung abgelehnt. Zuvor abgeschlossen: 2 von 3 Schritten."
      : "Stopped at step “write_products” — cause: Sign-in rejected. Completed before that: 2 of 3 steps.";
  if (sentence !== expected)
    throw new Error(`${label} states the outcome as ${JSON.stringify(sentence)}`);
  // The error the failing step reported has to reach the reader; a sheet that
  // swallows it sends someone to the terminal for the one fact they came for.
  const failure = page.locator('[data-testid="run-detail-error"]');
  if (!(await failure.isVisible()))
    throw new Error(`${label} hides the error of a run whose last step failed`);
  // …and exactly ONCE. It used to stand in its own block AND in the step card,
  // so the reader read one failure twice and wondered whether there were two.
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
  // The fix, for THIS cause: a rejected sign-in leads to the connector.
  const remedy = page.locator('[data-testid="run-detail-cause-remedy"]');
  await remedy.waitFor();
  const remedyHref = await remedy.getAttribute("href");
  if (remedyHref !== `/cockpit/connectors/${runConnectorId}`)
    throw new Error(`${label} remedy leads to ${remedyHref}, not to the connector to sign in to`);
  const remedyText = (await remedy.innerText()).trim();
  if (remedyText !== (language === "de" ? "Neu anmelden" : "Sign in again"))
    throw new Error(`${label} remedy reads ${JSON.stringify(remedyText)}`);
  const audit = await page.locator('[data-testid="run-detail-cause-more-0"]').getAttribute("href");
  if (!audit?.startsWith("/cockpit/audit?resource_type=execution&resource_id="))
    throw new Error(`${label} offers no way into the audit trail (${audit})`);
  // The payload is evidence, not the headline: closed until asked for, and a
  // failed run's newest output is named for its step — never "Ergebnis".
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
  // The heading is part of the block, so compare what follows it.
  const body = shown.split("\n").slice(1).join("\n").trim();
  if (body === "null" || body === "undefined")
    throw new Error(
      `${label} prints '${body}' as the run's result — a step that produced nothing has no result section`,
    );
  // Running it again states its consequence before anything runs, and
  // cancelling runs nothing.
  let reruns = 0;
  const countRerun = (request) => {
    if (request.method() === "POST" && request.url().includes("/rerun")) reruns += 1;
  };
  page.on("request", countRerun);
  try {
    await page.locator('[data-testid="run-rerun-open"]').click();
    const consequence = page.locator('[data-testid="run-rerun-consequence"]');
    await consequence.waitFor();
    const said = await consequence.innerText();
    for (const word of language === "de"
      ? ["derselben Version", "derselben Eingabe", "echter Lauf"]
      : ["same version", "same input", "real run"])
      if (!said.includes(word))
        throw new Error(`${label} rerun dialog does not state its consequence: ${said}`);
    await page.locator('[data-testid="run-rerun-cancel"]').click();
    await consequence.waitFor({ state: "hidden" });
  } finally {
    page.off("request", countRerun);
  }
  if (reruns !== 0) throw new Error(`${label} cancelling the rerun started one`);
  // Leave the sheet as it was photographed: drawer closed.
  await toggle.click();
  await result.waitFor({ state: "hidden" });
}

/**
 * A workflow's own page: red leads to its cause, the cause is the cockpit's
 * sentence, and the latest runs lead to their sheets.
 */
async function assertWorkflowDetail(page, label, language) {
  const badge = page.locator('[data-testid="workflow-health-badge"]');
  await badge.waitFor();
  const cause = page.locator('[data-testid="workflow-cause"]');
  await cause.waitFor();
  const causeText = await page.locator('[data-testid="workflow-cause-cause"]').innerText();
  // The newest failed run in the fixture stopped at `write_products` because
  // a sign-in was rejected; the engine's English reason is NOT the cause.
  const expected = language === "de" ? "Ursache: Anmeldung abgelehnt" : "cause: Sign-in rejected";
  if (!causeText.includes(expected) || causeText.includes("consecutive"))
    throw new Error(`${label} states the workflow's cause as ${JSON.stringify(causeText)}`);
  const guidance = await page.locator('[data-testid="workflow-cause-guidance"]').innerText();
  if (!guidance.includes("3 consecutive scheduled runs failed"))
    throw new Error(`${label} drops the engine's own wording of the health reason`);
  if (!(await page.locator('[data-testid="workflow-cause-remedy"]').isVisible()))
    throw new Error(`${label} shows red with no way to the fix`);
  const runs = page.locator('[data-testid^="workflow-recent-run-"]');
  const count = await runs.count();
  if (count < 1 || count > 5)
    throw new Error(`${label} lists ${count} latest runs, not up to five`);
  const first = await runs.first().getAttribute("href");
  if (!first?.startsWith("/cockpit/runs/"))
    throw new Error(`${label} latest run leads to ${first}, not to its sheet`);
  const all = await page.locator('[data-testid="workflow-all-runs"]').getAttribute("href");
  if (all !== `/cockpit/runs?workflow_id=${uuid}`)
    throw new Error(`${label} "all runs" leads to ${all}`);
  // The approval card is headed by what the reader decides by.
  const headline = await page.locator('[data-testid="authority-headline"]').first().innerText();
  for (const expectedPart of language === "de"
    ? ["Produktion", "gültig bis", "bis zu 24 Läufe"]
    : ["Production", "valid until", "up to 24 runs"])
    if (!headline.includes(expectedPart))
      throw new Error(
        `${label} authority headline ${JSON.stringify(headline)} lacks ${expectedPart}`,
      );
  const headlineTitle = await page
    .locator('[data-testid="authority-headline"]')
    .first()
    .getAttribute("title");
  if (headlineTitle !== hostileAuthority.id)
    throw new Error(`${label} authority id is not kept on the headline's title`);
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
    //
    // A card is in the list for the same reason: a paragraph INSIDE a card is
    // indented by the card's own padding on purpose, and measuring it reported
    // a 16px offset for a card that sat exactly under its heading. For years
    // the first match was the page description in the header, so neither this
    // nor a real misalignment of every list could show; removing descriptions
    // that restated their titles made the check measure the body at last.
    const body = document.querySelector(
      'main [data-testid$="-context"], main article, main [data-slot="card"], main [data-slot="table-container"], main section, main p',
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
/** Every file this run has written, so a second write to one is caught where it happens. */
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

/**
 * A contact sheet: assembled from frames already on disk, named from the last
 * answer this stand gave. Counted like every other frame.
 */
async function shootSheet(page, label, options) {
  await prepareOutput();
  const path = resolve(outputDir, stand.sheetName(label));
  claimFrame(path, label);
  await page.screenshot({ animations: "disabled", ...options, path });
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
      // A bucket route writes its own frame: `decisions-bucket-failing`, not a
      // second file called `decisions` that silently overwrites the first.
      const artifactRoute = artifactRouteName(route);
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
      // Any UUID-shaped text, not the one this fixture happens to know.
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
      await assertHeadingAlignment(page, `${locale.artifact}/${viewport.name}/${route}`);
      await assertInteractiveSelectors(page, `${locale.artifact}/${viewport.name}/${route}`);
      await assertBlankLists(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route === "operations")
        await assertOperationsNamesItsCauses(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route.startsWith("connectors?health="))
        await assertUnhealthyConnectorsOnly(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route.startsWith("audit?") && route.includes("action="))
        await assertAuditActionChip(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route === "chat") await assertChat(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route === "runs")
        await assertOpenOnce(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (/^runs\/.+/.test(route))
        await assertRunDetail(page, `${locale.artifact}/${viewport.name}/${route}`, locale.name);
      if (/^workflows\/.+/.test(route))
        await assertWorkflowDetail(
          page,
          `${locale.artifact}/${viewport.name}/${route}`,
          locale.name,
        );
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
    await verifyHealthyOperationsIsQuiet(page, `${locale.artifact}/${viewport.name}/operations`);
    await verifyScheduleHolds(page, stand, uuid, locale.name, operationalOverview, (state) =>
      shoot(page, `${locale.artifact}-${viewport.name}-schedule-held-${state}`, {
        fullPage: false,
      }),
    );
    await verifyChatApprovals(page, stand, conversation, locale.name, (state) =>
      shoot(page, `${locale.artifact}-${viewport.name}-chat-approval-${state}`, {
        fullPage: false,
      }),
    );
    await verifyChatChoices(page, stand, conversation, locale.name, (state) =>
      shoot(page, `${locale.artifact}-${viewport.name}-chat-choice-${state}`, { fullPage: false }),
    );
    await verifyChatReplies(page, stand, conversation, locale.name, (state) =>
      shoot(page, `${locale.artifact}-${viewport.name}-chat-reply-${state}`, { fullPage: false }),
    );
    await verifyChatReauth(page, stand, conversation);
    // Once per locale and theme, on desktop: the assertion is about which
    // state a page renders, not about layout, and each refused read waits out
    // a retry — repeating it at every width would spend the sweep's headroom.
    if (viewport.name === "desktop")
      await verifyLoadFailures(page, stand, conversation, (state) =>
        shoot(page, `${locale.artifact}-${viewport.name}-load-failed-${state}`, {
          fullPage: false,
        }),
      );
    await verifyChatOAuth(page, stand, conversation, locale.name);
    await verifyChatActivation(page, stand, conversation, locale.name);
    await verifyChatActivity(page, stand, conversation, locale.name, (state) =>
      shoot(page, `${locale.artifact}-${viewport.name}-chat-activity-${state}`, {
        fullPage: false,
      }),
    );
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
