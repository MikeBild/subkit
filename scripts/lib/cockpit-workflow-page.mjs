// The workflow page, in the order a reader asks: may it run on its own → how
// is it called → what does it take and return → what does it do.
//
// Fixtures follow the engine's real schemas, and each scenario holds exactly
// one automation state. Hostile on purpose: every identifier is a real, distinct
// UUID (the workflow's own must appear ONLY inside the fenced call), a step
// carries a credential-shaped header, a hook is signed with a generic scheme,
// a second approval exists for another environment, and one pass has no public
// address configured at all.
//
// What it stands on:
//
// - "Automatischer Betrieb" says ONE state with ONE action, and the action
//   beside the title is that same action — never a link that only scrolls.
// - An approved workflow offers no approval button, in the panel or the title.
// - After a grant the state flips to approved where the reader stands, and the
//   hook is no longer shown as waiting.
// - "Aufrufen" shows only the ways that exist, lands on the way the workflow is
//   really started, and hands out a call that names its environment.

import { assertNoVisibleUuids } from "./cockpit-visible-uuids.mjs";

export const WORKFLOW = "d2f4a6c8-1b3d-4e5f-8a7b-9c0d1e2f3a41";
const VERSION = "7e9a1c3b-5d2f-4b46-9e80-1a3c5e7f9b52";
const DRAFT = "3b5d7f91-2a4c-4e68-b0c2-4e6a8c0e2f63";
const SCHEDULE = "9c1e3a5b-7d4f-4a26-8b13-6f8a0c2e4d74";
const DEV_SCHEDULE = "2e4a6c8d-1f3b-4d57-9a02-7b9d1f3a5c16";
const REPAIR_CANDIDATE = "a8c0e2f4-6b1d-4f39-8c5e-0d2f4a6c8e27";
const HOOK = "5a7c9e1f-3b2d-4f48-a6c0-8e0a2c4e6b85";
const API_CONNECTOR = "1f3b5d7c-9e4a-4c26-b813-2f4b6d8e0a96";
const MAIL_CONNECTOR = "8d0f2b4c-6e1a-4d37-9a5c-3e5a7c9b1da7";
const CALLED = "4c6e8a0b-2d1f-4b59-8e07-b1d3f5a7c9b8";
const GRANT = "e1a3c5d7-9b2f-4d48-a6c0-7e9a1c3e5fc9";
const DEV_GRANT = "b7d9f1a3-5c4e-4a26-9b80-2d4f6a8c0ed0";
const OLD_GRANT = "6f8a0c2e-4d1b-4e37-8c5a-9b1d3f5a7ce1";
const CREATOR = "2a4c6e80-1b3d-4f59-a7c1-5e7a9c1b3df2";
const TENANT = "0c2e4a6b-8d1f-4e37-9a50-b2d4f6a8c003";
const PUBLIC = "https://engine.example.org";
const SLUG = "example-api-demo-fetch";
const HOOK_SLUG = "auth-notify";

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const SAMPLE = { limit: 5, recipient_email: "<recipient_email>" };

function record(state) {
  return {
    id: WORKFLOW,
    tenant_id: TENANT,
    name: "Example API Demo Fetch",
    slug: SLUG,
    description: "Lädt Nutzer aus der Example API und meldet das Ergebnis per E-Mail.",
    lifecycle: "active",
    // Stored in an earlier definition format: shown as stored, refused to run.
    legacy: Boolean(state.legacy),
    current_version: 9,
    current_version_id: VERSION,
    draft_version_id: state.scenario === "apply" ? DRAFT : VERSION,
    health_state: "ok",
    health_reason: null,
    health_changed_at: null,
    created_at: "2026-06-01T08:00:00.000Z",
    updated_at: "2026-08-10T09:00:00.000Z",
    last_executed_at: "2026-08-10T07:00:00.000Z",
    input_schema: INPUT_SCHEMA,
    output_schema: OUTPUT_SCHEMA,
    trigger: null,
    schedule: null,
    // The number of ACTIVE hooks: a switched-off hook is not one.
    webhooks_active:
      state.scenario === "manual" || state.scenario === "paused" || state.scheduleOnly ? 0 : 1,
    effective_trigger: {
      kind: state.scenario === "manual" ? "request" : "webhook",
      source: state.scenario === "manual" ? "default" : "binding",
      state: "active",
    },
    steps: [
      {
        id: "fetch_data",
        kind: "request",
        method: "GET",
        path: "/users",
        connector_id: API_CONNECTOR,
        query: { limit: 10 },
        // Two credential-shaped headers. A literal secret pasted into the
        // definition is masked; a reference is configuration and shown as stored.
        headers: {
          Accept: "application/json",
          Authorization: "Bearer plain-secret-token",
          "X-Api-Key": "{{credentials.api_key}}",
        },
      },
      {
        id: "check_status",
        kind: "branch",
        when: "fetch_data.status = 200",
        then_steps: ["shape_success"],
        else_steps: ["shape_failure"],
      },
      {
        id: "shape_success",
        kind: "transform",
        // An identifier inside an expression is payload: shown whole, in a block.
        expression: `return { ok: true, source: "${CALLED}" };`,
      },
      { id: "shape_failure", kind: "transform", expression: "return { ok: false };" },
      { id: "each_user", kind: "loop", over: "fetch_data.data", body: ["send_email"] },
      {
        id: "send_email",
        kind: "request",
        method: "POST",
        path: "/v1/messages/send",
        connector_id: MAIL_CONNECTOR,
        body: { to: "{{recipient}}", subject: "Bericht" },
      },
      { id: "pause", kind: "wait", duration_ms: 90_000 },
      {
        id: "approval",
        kind: "wait_for_event",
        event_name: "report.approved",
        timeout_ms: 7_200_000,
      },
      { id: "sub", kind: "call", workflow_id: CALLED, workflow_slug: "send-report" },
      { id: "fan", kind: "parallel", branches: [["shape_success"], ["shape_failure"]] },
    ],
  };
}

const INPUT_SCHEMA = {
  type: "object",
  required: ["recipient_email", "limit"],
  properties: {
    recipient_email: {
      type: "string",
      format: "email",
      description: "Wer den Bericht bekommt",
      example: "ops@example.org",
    },
    limit: { type: "integer", default: 5 },
    mode: { type: "string", enum: ["draft", "live"] },
    options: {
      type: "object",
      properties: { deep: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } },
    },
  },
};
const OUTPUT_SCHEMA = {
  type: "object",
  properties: { id: { type: "string" }, threadId: { type: "string" } },
};

/** The call exactly as the engine renders it — the same shape the shared renderer prints. */
function snippet(environment, language) {
  const body = JSON.stringify({ source: "saved", workflow_id: WORKFLOW, input: SAMPLE });
  if (language === "curl")
    return [
      `curl -sS -X POST '${PUBLIC}/v1/executions' \\`,
      `  -H 'authorization: Bearer '"$SK_API_KEY" \\`,
      `  -H 'x-subkit-environment: ${environment}' \\`,
      `  -H 'content-type: application/json' \\`,
      `  -d '${body}'`,
    ].join("\n");
  if (language === "node")
    return `const res = await fetch("${PUBLIC}/v1/executions", {\n  method: "POST",\n  headers: { "x-subkit-environment": "${environment}" },\n  body: JSON.stringify(${body}),\n});`;
  return `import requests\n\nres = requests.post(\n    "${PUBLIC}/v1/executions",\n    headers={"x-subkit-environment": "${environment}"},\n    json=${body},\n)`;
}

function invocation(state) {
  const { hooks, schedules, ...rest } = fullInvocation(state);
  // A reader without the right to a list gets it ABSENT, and is told so.
  return state.hiddenLists
    ? { ...rest, visibility: { hooks: false, schedules: false } }
    : { ...rest, hooks, schedules, visibility: { hooks: true, schedules: true } };
}

function fullInvocation(state) {
  const approved = state.scenario === "approved";
  const address = state.address ? PUBLIC : null;
  const bound = state.scenario !== "manual";
  return {
    workflow_id: WORKFLOW,
    slug: SLUG,
    legacy: Boolean(state.legacy),
    base_url: address,
    http: {
      method: "POST",
      path: "/v1/executions",
      url: address ? `${address}/v1/executions` : null,
      headers: ["authorization", "x-subkit-environment", "content-type"],
      body: { source: "saved", workflow_id: WORKFLOW, input: SAMPLE },
      snippets: address
        ? Object.fromEntries(
            ["dev", "prod"].map((environment) => [
              environment,
              Object.fromEntries(
                ["curl", "node", "python"].map((language) => [
                  language,
                  snippet(environment, language),
                ]),
              ),
            ]),
          )
        : null,
    },
    hooks: bound
      ? [
          {
            slug: HOOK_SLUG,
            path: `/v1/hooks/${HOOK_SLUG}`,
            url: address ? `${address}/v1/hooks/${HOOK_SLUG}` : null,
            verifier: "hmac",
            signed: true,
            signing_headers: ["x-example-signature", "x-example-delivery", "x-example-timestamp"],
            hmac: {
              algorithm: "sha256",
              encoding: "hex",
              signed_payload: "{timestamp}.{body}",
              signature_prefix: "sha256=",
            },
            state: state.scenario === "paused" ? "inactive" : approved ? "active" : "held",
            environment: "prod",
          },
        ]
      : [],
    mcp: {
      tool_name: `wf_${SLUG}`,
      fallback: { tool_name: "run_workflow", arguments: { workflow: SLUG, input: SAMPLE } },
    },
    schedules:
      bound && !state.hookOnly
        ? [
            {
              cron: "0 7 * * *",
              timezone: "Europe/Berlin",
              environment: "prod",
              input: { report: "daily" },
              state: state.scenario === "paused" ? "paused" : approved ? "active" : "held",
              next_fire_at: approved ? "2099-01-01T06:00:00.000Z" : null,
            },
          ]
        : [],
    cli: {
      command: `sk workflows run ${SLUG} --input '${JSON.stringify(SAMPLE)}'`,
      environment: "dev",
    },
    input: { source: "declared", schema: INPUT_SCHEMA, sample: SAMPLE },
    output: { schema: OUTPUT_SCHEMA },
    webhook_input_shape: {
      id: "string",
      type: "string",
      timestamp: "number",
      headers: "object",
      body: "json",
    },
    // "An approval is stored" — also while it no longer fits (repair). Whether
    // a run is admitted is the panel's verdict, not this field's.
    authority: {
      dev: "held_preview_only",
      prod: approved || state.scenario === "repair" ? "live_run_allowed" : "held_preview_only",
    },
  };
}

function authority(overrides = {}) {
  const now = Date.now();
  return {
    id: GRANT,
    workflow_id: WORKFLOW,
    workflow_version_id: VERSION,
    effect_manifest_digest: "7".repeat(64),
    execution_environment: "prod",
    valid_from: new Date(now - 3_600_000).toISOString(),
    valid_until: new Date(now + 20 * 86_400_000).toISOString(),
    max_runs: 30,
    reserved_runs: 2,
    remaining_runs: 28,
    active_version: true,
    ready_for_new_run: true,
    state: "approved",
    created_at: new Date(now - 3_600_000).toISOString(),
    created_by: CREATOR,
    revoked_at: null,
    revoked_by: null,
    target_constraints: { targets: [] },
    effect_manifest: {
      schema_version: 1,
      tenant_id: TENANT,
      workflow_id: WORKFLOW,
      workflow_version_id: VERSION,
      workflow_digest: "8".repeat(64),
      execution_environment: "prod",
      execution_options_digest: "9".repeat(64),
      effects: [
        {
          tenant_id: TENANT,
          step_id: "send_email",
          connector_id: MAIL_CONNECTOR,
          driver: "http",
          environment: "prod",
          request_digest: "1".repeat(64),
          configuration_digest: "2".repeat(64),
          credential_binding_digest: "3".repeat(64),
          target: "https://mail.example.com/v1/messages/send",
          rewrites_target: false,
          operation: "POST",
          effect: "write",
        },
      ],
      issues: [],
    },
    ...overrides,
  };
}

function authorities(state) {
  const revoked = authority({
    id: OLD_GRANT,
    state: "revoked",
    revoked_at: new Date(Date.now() - 86_400_000).toISOString(),
    ready_for_new_run: false,
  });
  const dev = authority({ id: DEV_GRANT, execution_environment: "dev" });
  // Production approved while a development schedule still waits: the
  // development approval is the one that does not exist yet.
  if (state.devPending) return [authority(), revoked];
  if (state.scenario === "approved" || state.scenario === "repair")
    return [
      authority(state.expiring ? { remaining_runs: 1, reserved_runs: 29 } : {}),
      dev,
      revoked,
    ];
  return [revoked];
}

const ROW_STATE = {
  grant: "approval_required",
  approved: "authorized",
  repair: "approval_required",
  apply: "approval_required",
  paused: "paused",
};

function automationStatus(state) {
  if (state.scenario === "manual") return { schedules: [], inbound_hooks: [] };
  const rowState = ROW_STATE[state.scenario];
  const row = (schedule_id, environment) => ({
    schedule_id,
    workflow_id: WORKFLOW,
    state: environment === "dev" && state.devPending ? "approval_required" : rowState,
    ready: rowState === "authorized" && !(environment === "dev" && state.devPending),
    cron: "0 7 * * *",
    timezone: "Europe/Berlin",
    environment,
    next_run_at: null,
  });
  return {
    schedules: state.hookOnly
      ? []
      : [row(SCHEDULE, "prod"), ...(state.devSchedule ? [row(DEV_SCHEDULE, "dev")] : [])],
    inbound_hooks: state.scheduleOnly
      ? []
      : [
          {
            inbound_hook_id: HOOK,
            workflow_id: WORKFLOW,
            slug: HOOK_SLUG,
            state: rowState,
            ready: rowState === "authorized",
            environment: "prod",
            admission_hold:
              state.scenario === "grant"
                ? {
                    reason_code: "execution_authority_required",
                    observed_at: "2026-08-10T08:30:00.000Z",
                  }
                : null,
            last_refused_at: null,
            last_refused_reason: null,
          },
        ],
  };
}

function diagnosis(state) {
  return {
    workflow_id: WORKFLOW,
    workflow_version_id: state.scenario === "apply" ? DRAFT : VERSION,
    environment: "prod",
    is_current: state.scenario !== "apply",
    diagnoses: state.trialNeeded
      ? // The gate has not seen what the mail step sends: a trial run shows it.
        [
          {
            code: "report_inspection_missing",
            subject: { step_id: "send_email" },
            evidence: {},
            remedy_kind: "prepare",
          },
        ]
      : state.scenario === "repair"
        ? [
            {
              code: "execution_authority_changed",
              reason: "not_utf8",
              subject: { step_id: "send_email" },
              evidence: {},
              remedy_kind: "patch",
              fixer: "use_utf8_encoder",
            },
            {
              code: "dynamic_request",
              subject: { step_id: "fetch_data" },
              evidence: {},
              remedy_kind: "author",
            },
          ]
        : [],
  };
}

/**
 * The review as the engine answers it. The suggestion follows what starts the
 * workflow in the reviewed environment: a production review of a workflow
 * with a daily schedule and a hook gets thirty days and both added up — a
 * development review, where neither runs, the one-run default.
 */
function preview(environment, versionId, state) {
  const from = Date.now();
  const started = state.scenario !== "manual" && (environment === "prod" || state.devSchedule);
  const refused = state.unsupported || state.scenario === "repair";
  const hooked = environment === "prod" && !state.scheduleOnly;
  const scheduled = !state.hookOnly && started ? 30 : 0;
  if (started)
    return {
      manifest: {
        schema_version: 1,
        workflow_id: WORKFLOW,
        workflow_version_id: versionId,
        execution_environment: environment,
        effects: [],
        issues: refused ? [{ step_id: "send_email", code: "dynamic_request" }] : [],
      },
      digest: "c".repeat(64),
      eligible_for_repeated_runs: !refused,
      preparation_required: Boolean(state.trialNeeded),
      unavailable_steps: refused ? ["send_email"] : [],
      execution_shape: { requests: [], iterations: [], run_limit_is_request_limit: false },
      schedules: [],
      suggested_bounds: {
        valid_from: new Date(from).toISOString(),
        valid_until: new Date(from + 30 * 86_400_000).toISOString(),
        // 42 calls in 14 days, projected over 30 and doubled, plus the schedule's 30.
        max_runs: scheduled + (hooked ? 180 : 0),
      },
      suggested_bounds_basis: hooked
        ? {
            kind: "hook",
            scheduled_runs: scheduled,
            observed_deliveries: 42,
            observed_days: 14,
            minimum_applied: false,
          }
        : { kind: "schedule", scheduled_runs: scheduled },
    };
  return {
    manifest: {
      schema_version: 1,
      workflow_id: WORKFLOW,
      workflow_version_id: versionId,
      execution_environment: environment,
      effects: [],
      issues: [],
    },
    digest: "c".repeat(64),
    eligible_for_repeated_runs: true,
    unavailable_steps: [],
    execution_shape: { requests: [], iterations: [], run_limit_is_request_limit: false },
    schedules: [],
    suggested_bounds: {
      // One clock reading: two a millisecond apart are not a whole number of hours.
      valid_from: new Date(from).toISOString(),
      valid_until: new Date(from + 86_400_000).toISOString(),
      max_runs: 1,
    },
    suggested_bounds_basis: { kind: "manual" },
  };
}

export function api(state) {
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === `/v1/workflows/${WORKFLOW}`) return json(route, record(state));
    if (path === `/v1/workflows/${WORKFLOW}/invocation`) return json(route, invocation(state));
    // The version the record names as its draft: the saved change while one
    // waits, otherwise the running version itself.
    if (path === `/v1/workflows/${WORKFLOW}/draft`) {
      const waiting = state.scenario === "apply";
      return json(route, {
        workflow_id: WORKFLOW,
        version_id: waiting ? DRAFT : VERSION,
        current_version_id: VERSION,
        version: waiting ? 10 : 9,
        definition: { name: "Example API Demo Fetch", steps: record(state).steps },
      });
    }
    if (path === `/v1/workflows/${WORKFLOW}/automation-status`)
      return json(route, automationStatus(state));
    if (path === `/v1/workflows/${WORKFLOW}/diagnosis`) {
      state.diagnosed.push(url.searchParams.get("environment"));
      return json(route, diagnosis(state));
    }
    if (path === `/v1/workflows/${WORKFLOW}/execution-authorities`) {
      if (request.method() === "POST") {
        state.grants.push(request.postDataJSON());
        // The grant lands: from here on the engine answers as approved.
        state.scenario = "approved";
        return json(route, authority(), 201);
      }
      return json(route, { items: authorities(state), next_cursor: null });
    }
    const previewed = path.match(
      new RegExp(`^/v1/workflows/${WORKFLOW}/versions/([^/]+)/authority-preview$`),
    );
    if (previewed) {
      state.previews += 1;
      return json(route, preview(url.searchParams.get("environment"), previewed[1], state));
    }
    if (/\/versions\/[^/]+\/prepare-authority$/.test(path) && request.method() === "POST") {
      state.prepares?.push(request.postDataJSON());
      return json(route, { prepared: true });
    }
    if (path === `/v1/workflows/${WORKFLOW}/boundary-proposals`)
      return json(route, { proposals: [], unproposable: [] });
    if (path === `/v1/workflows/${WORKFLOW}/repairs` && request.method() === "POST") {
      state.repairs?.push(request.postDataJSON());
      return json(route, { status: "proposed", candidate_id: REPAIR_CANDIDATE });
    }
    if (path === `/v1/schedules/${SCHEDULE}` && request.method() === "PUT") {
      state.resumed.push(request.postDataJSON());
      state.scenario = "grant";
      return json(route, { id: SCHEDULE, workflow_id: WORKFLOW, paused: false });
    }
    if (path === "/v1/schedules") {
      const schedule = (id, execution_mode) => ({
        id,
        workflow_id: WORKFLOW,
        workflow_slug: SLUG,
        workflow_name: "Example API Demo Fetch",
        prepared_version_id: null,
        cron: "0 7 * * *",
        timezone: "Europe/Berlin",
        execution_mode,
        paused: state.scenario === "paused",
        admission_hold: null,
        input: { report: "daily" },
        created_at: "2026-06-01T08:00:00.000Z",
      });
      const schedules =
        state.scenario === "manual" || state.hookOnly
          ? []
          : [
              schedule(SCHEDULE, "prod"),
              ...(state.devSchedule ? [schedule(DEV_SCHEDULE, "dev")] : []),
            ];
      return json(route, { schedules, total: schedules.length });
    }
    if (path === "/v1/connectors")
      return json(route, {
        items: [
          { id: API_CONNECTOR, display_name: "Example API Demo" },
          { id: MAIL_CONNECTOR, display_name: "Mail" },
        ],
        total: 2,
      });
    if (path === "/v1/executions" && url.searchParams.get("workflow_id") === WORKFLOW)
      return json(route, { items: [], total: 0 });
    return route.fallback();
  };
}

export const isPageApi = (url) => {
  const { pathname, searchParams } = new URL(url);
  return (
    pathname.includes(WORKFLOW) ||
    pathname.startsWith("/v1/schedules") ||
    pathname === "/v1/connectors" ||
    (pathname === "/v1/executions" && searchParams.get("workflow_id") === WORKFLOW)
  );
};

const WORDS = {
  de: {
    states: {
      grant: "Freigabe nötig",
      approved: "Freigegeben",
      repair: "Reparatur nötig",
      apply: "Übernahme nötig",
      paused: "Pausiert",
      manual: "Auf Abruf",
      legacy: "Altes Format",
    },
    fixInChat: "Im Chat beheben",
    unconfirmed: "nicht bestätigt",
    hidden: "darfst du nicht sehen",
    approve: "Jetzt freigeben",
    view: "Freigabe ansehen",
    extend: "Verlängern",
    review: "Änderung prüfen",
    resume: "Fortsetzen",
    repair: "Automatisch reparieren",
    change: "Im Chat ändern",
    run: "Ausführen",
    previewOnly: "Ohne Freigabe läuft nur ein Probelauf ohne Wirkung.",
    noAddress: "keine öffentliche Adresse",
    where: "Die Eingabe steht im Body unter „input“. Query-Parameter gibt es nicht.",
    webhookBody: "input.body",
    tabs: { http: "HTTP", webhook: "Webhook", mcp: "MCP", schedule: "Zeitplan", cli: "CLI" },
    branch: "wenn fetch_data.status = 200 → shape_success, sonst shape_failure",
    daily: "täglich um 07:00",
    waiting: "Wartet auf Freigabe",
    active: "Aktiv",
  },
  en: {
    states: {
      grant: "Approval needed",
      approved: "Approved",
      repair: "Repair needed",
      apply: "Change waiting",
      paused: "Paused",
      manual: "On request",
      legacy: "Outdated format",
    },
    fixInChat: "Fix it in the chat",
    unconfirmed: "not confirmed",
    hidden: "may not see",
    approve: "Approve now",
    view: "View approval",
    extend: "Extend",
    review: "Review change",
    resume: "Resume",
    repair: "Repair automatically",
    change: "Change in chat",
    run: "Run",
    previewOnly: "Without approval this is only a trial run without effect.",
    noAddress: "No public address",
    where: "Input goes in the request body under “input”. There are no query parameters.",
    webhookBody: "input.body",
    tabs: { http: "HTTP", webhook: "Webhook", mcp: "MCP", schedule: "Schedule", cli: "CLI" },
    branch: "if fetch_data.status = 200 → shape_success, else shape_failure",
    daily: "daily at 07:00",
    waiting: "Waiting for approval",
    active: "Active",
  },
};

async function text(page, testId) {
  const element = page.getByTestId(testId);
  if (!(await element.count())) return null;
  return (await element.first().innerText()).trim();
}

/** Open the page in one scenario and wait until its state is said. */
export async function open(page, stand, state, scenario) {
  state.scenario = scenario;
  await stand.visit(page, `workflows/${WORKFLOW}`);
  const panel = page.getByTestId("workflow-automation");
  await page
    .getByTestId("workflow-automation-state")
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  return panel;
}

/**
 * One state, one action, and the title says the same. `action` is the label
 * the panel's own button must carry (null: none), `title` the label beside the
 * page title.
 */
async function expectState(page, panel, where, words, scenario, { action, title }) {
  const dataState = await panel.getAttribute("data-state");
  if (dataState !== scenario) throw new Error(`${where}: the panel is in "${dataState}"`);
  const said = await text(page, "workflow-automation-state");
  if (said !== words.states[scenario])
    throw new Error(`${where}: the state reads "${said}", not "${words.states[scenario]}"`);
  const actions = page.getByTestId("workflow-automation-action");
  if ((await actions.count()) !== (action ? 1 : 0))
    throw new Error(`${where}: the panel offers ${await actions.count()} primary actions`);
  if (action && (await text(page, "workflow-automation-action")) !== action)
    throw new Error(
      `${where}: the panel's action reads "${await text(page, "workflow-automation-action")}", not "${action}"`,
    );
  const titled = await text(page, "detail-action");
  if (titled !== title)
    throw new Error(`${where}: the action beside the title reads "${titled}", not "${title}"`);
  // Never a link that only scrolls to a section of the same page.
  const jumps = await page.locator('header a[href*="#"]').count();
  if (jumps) throw new Error(`${where}: the title carries a jump link`);
  // Exactly one filled action on the page: running the workflow.
  const filled = await page
    .getByTestId("detail-workflows")
    .locator('button[data-variant="default"], a[data-variant="default"]')
    .allInnerTexts();
  if (filled.length !== 1 || filled[0].trim() !== words.run)
    throw new Error(`${where}: the filled actions are ${JSON.stringify(filled)}`);
  // The badges the panel replaced.
  for (const gone of ["authority-schedule-held", "authority-hook-held", "authority-grant-open"])
    if (await page.getByTestId(gone).count())
      throw new Error(`${where}: "${gone}" is back on the page`);
  for (const stale of ["Prüfung nötig", "Review needed", "Freigabe prüfen", "Review approval"])
    if ((await page.getByTestId("detail-workflows").innerText()).includes(stale))
      throw new Error(`${where}: the page still says "${stale}"`);
}

export async function verifyWorkflowPage(page, stand, localeName, capture) {
  const words = WORDS[localeName];
  const state = {
    scenario: "grant",
    address: true,
    expiring: false,
    grants: [],
    resumed: [],
    diagnosed: [],
    previews: 0,
  };
  const handler = api(state);
  await page.route(isPageApi, handler);
  const at = (name) => `/workflows/<page: ${name}> (${localeName})`;
  try {
    // ── Freigabe nötig: one state, one action, the title says the same ───────
    let where = at("grant");
    let panel = await open(page, stand, state, "grant");
    await expectState(page, panel, where, words, "grant", {
      action: words.approve,
      title: words.approve,
    });
    if (state.previews !== 0)
      throw new Error(`${where}: opening the page ran ${state.previews} authority reviews`);
    if (state.diagnosed.some((environment) => environment !== "prod"))
      throw new Error(`${where}: a hook-started workflow was diagnosed in ${state.diagnosed}`);
    const headline = (await text(page, "workflow-automation-headline")) ?? "";
    if (
      !headline.includes("v9") ||
      !headline.includes(localeName === "de" ? "Produktion" : "Production")
    )
      throw new Error(`${where}: the headline lacks version or environment: ${headline}`);
    const triggers = (await text(page, "workflow-automation-triggers")) ?? "";
    if (!triggers.includes(words.daily) || !triggers.includes(HOOK_SLUG))
      throw new Error(`${where}: the triggers read "${triggers}"`);

    // The page's order: state → call → input/output → steps → runs → folded rest.
    const order = await page.getByTestId("detail-workflows").evaluate((root) =>
      [
        "workflow-automation",
        "workflow-invocation",
        "workflow-io",
        "workflow-steps",
        "workflow-recent-runs",
        "workflow-technical",
        "workflow-former-grants",
        "detail-conversations",
      ].map((testId) => {
        const node = root.querySelector(`[data-testid="${testId}"]`);
        return node ? Math.round(node.getBoundingClientRect().top + root.scrollTop) : null;
      }),
    );
    if (order.some((top) => top === null))
      throw new Error(`${where}: a section is missing: ${JSON.stringify(order)}`);
    if (order.some((top, index) => index > 0 && top <= order[index - 1]))
      throw new Error(`${where}: the sections are out of order: ${JSON.stringify(order)}`);
    for (const gone of ["workflow-tab-dag", "workflow-tab-overview", "detail-overview"])
      if (await page.getByTestId(gone).count())
        throw new Error(`${where}: the old "${gone}" is still on the page`);
    if (await page.locator('[data-family-slot="detail-context"]').count())
      throw new Error(`${where}: the "Steuerung" row is still on the page`);

    // ── Aufrufen: the ways that exist, landing on the real trigger ───────────
    const tabs = await page.locator('[data-testid^="workflow-invocation-tab-"]').allInnerTexts();
    if (tabs.join("|") !== Object.values(words.tabs).join("|"))
      throw new Error(`${where}: the call tabs are ${JSON.stringify(tabs)}`);
    const landed = await page
      .locator('[data-testid^="workflow-invocation-tab-"][data-state="active"]')
      .getAttribute("data-testid");
    if (landed !== "workflow-invocation-tab-webhook")
      throw new Error(`${where}: a hook-started workflow lands on ${landed}`);
    const hookUrl = (await text(page, "workflow-invocation-hook-0-url")) ?? "";
    if (!hookUrl.includes(`${PUBLIC}/v1/hooks/${HOOK_SLUG}`))
      throw new Error(`${where}: the hook address reads "${hookUrl}"`);
    const signing = (await text(page, "workflow-invocation-hook-0-signing")) ?? "";
    for (const part of ["HMAC-SHA256", "{timestamp}.{body}", "x-example-signature"])
      if (!signing.includes(part)) throw new Error(`${where}: the signing line lacks ${part}`);
    if ((await text(page, "workflow-invocation-hook-0-state")) !== words.waiting)
      throw new Error(`${where}: a held hook is not shown as waiting`);
    const shape = await page
      .getByTestId("workflow-invocation-hook-shape")
      .locator("pre")
      .innerText();
    for (const field of ["id", "type", "timestamp", "headers", "body"])
      if (!shape.includes(`"${field}"`))
        throw new Error(`${where}: the input shape lacks ${field}`);
    await capture("workflow-page-grant");
    await page.getByTestId("workflow-invocation").scrollIntoViewIfNeeded();
    await capture("workflow-call-webhook");

    await page.getByTestId("workflow-invocation-tab-http").click();
    const httpUrl = (await text(page, "workflow-invocation-http-url")) ?? "";
    if (!httpUrl.includes(`${PUBLIC}/v1/executions`))
      throw new Error(`${where}: the call address reads "${httpUrl}"`);
    const block = page.getByTestId("workflow-invocation-snippet");
    const pre = block.locator("pre");
    if ((await pre.count()) !== 1) throw new Error(`${where}: the call is not in a fenced block`);
    let call = (await pre.textContent()) ?? "";
    // Production by default, said in the call; the identifier whole, inside it.
    for (const part of [
      "curl",
      "x-subkit-environment: prod",
      WORKFLOW,
      "$SK_API_KEY",
      '"source":"saved"',
    ])
      if (!call.includes(part)) throw new Error(`${where}: the call lacks ${part}`);
    if (call.includes("x-subkit-tenant"))
      throw new Error(`${where}: the call sends a tenant header`);
    const responses = (await text(page, "workflow-invocation-responses")) ?? "";
    for (const code of ["200", "202", "409"])
      if (!responses.includes(code)) throw new Error(`${where}: the responses lack ${code}`);
    const previewOnly = (await text(page, "workflow-invocation-preview-only")) ?? "";
    if (!previewOnly.includes(words.previewOnly))
      throw new Error(`${where}: an unapproved call is not said to be a trial run`);
    const toPanel = await page
      .getByTestId("workflow-invocation-to-automation")
      .getAttribute("href");
    if (toPanel !== "#workflow-automation")
      throw new Error(`${where}: the trial-run line leads to ${toPanel}`);
    // Copying hands over exactly the call that stands there.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByTestId("workflow-invocation-snippet-copy").click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    if (copied !== snippet("prod", "curl"))
      throw new Error(`${where}: copying did not hand over the call as shown`);
    await capture("workflow-call-http");
    await page.getByTestId("workflow-invocation-environment").click();
    await page.getByTestId("workflow-invocation-environment-dev").click();
    call = (await pre.textContent()) ?? "";
    if (!call.includes("x-subkit-environment: dev"))
      throw new Error(`${where}: choosing development did not change the call`);
    await page.getByTestId("workflow-invocation-language").click();
    await page.getByTestId("workflow-invocation-language-python").click();
    if (!((await pre.textContent()) ?? "").includes("requests.post("))
      throw new Error(`${where}: choosing Python did not change the call`);

    await page.getByTestId("workflow-invocation-tab-mcp").click();
    const tool = await page
      .getByTestId("workflow-invocation-mcp-tool")
      .locator("pre")
      .first()
      .textContent();
    if (tool.trim() !== `wf_${SLUG}`) throw new Error(`${where}: the tool name reads "${tool}"`);
    if (!((await text(page, "workflow-invocation-mcp-fallback")) ?? "").includes("run_workflow"))
      throw new Error(`${where}: the tool tab does not name the fallback`);
    await capture("workflow-call-mcp");

    await page.getByTestId("workflow-invocation-tab-schedule").click();
    const scheduled = (await text(page, "workflow-invocation-schedule-0")) ?? "";
    for (const part of [words.daily, "Europe/Berlin", "0 7 * * *"])
      if (!scheduled.includes(part)) throw new Error(`${where}: the schedule lacks "${part}"`);
    if (
      !(
        await page
          .getByTestId("workflow-invocation-schedule-0-input")
          .locator("pre")
          .first()
          .textContent()
      ).includes('"report": "daily"')
    )
      throw new Error(`${where}: the schedule's fixed input is not shown`);

    await page.getByTestId("workflow-invocation-tab-cli").click();
    const command = await page
      .getByTestId("workflow-invocation-cli")
      .locator("pre")
      .first()
      .textContent();
    if (!command.includes(`sk workflows run ${SLUG} --input`))
      throw new Error(`${where}: the command reads "${command}"`);
    // The command names no environment: the line says where it runs, and how
    // to reach production instead.
    const runsIn = (await text(page, "workflow-invocation-cli-environment")) ?? "";
    if (
      !runsIn.includes(localeName === "de" ? "Entwicklung" : "development") ||
      !runsIn.includes("HTTP")
    )
      throw new Error(`${where}: the command line does not say where it runs: "${runsIn}"`);

    // ── Eingabe / Ausgabe ────────────────────────────────────────────────────
    const input = await page.getByTestId("workflow-input").innerText();
    for (const part of [
      "recipient_email",
      "limit",
      "mode",
      "draft, live",
      "options",
      "deep",
      "tags",
      words.where,
      words.webhookBody,
    ])
      if (!input.includes(part)) throw new Error(`${where}: the input lacks "${part}"`);
    const required = await page.getByTestId("workflow-input-table-row-0").innerText();
    if (!required.includes(localeName === "de" ? "Ja" : "Yes"))
      throw new Error(`${where}: the required field is not marked: ${required}`);
    const output = await page.getByTestId("workflow-output").innerText();
    for (const part of ["id", "threadId"])
      if (!output.includes(part)) throw new Error(`${where}: the output lacks "${part}"`);

    // ── Schritte: one row each, opening to the whole configuration ──────────
    if (
      (await page.locator('[data-testid^="workflow-step-"][data-testid$="-toggle"]').count()) !== 10
    )
      throw new Error(`${where}: not every step has a row`);
    if ((await text(page, "workflow-step-1-essence")) !== words.branch)
      throw new Error(
        `${where}: the branch reads "${await text(page, "workflow-step-1-essence")}"`,
      );
    if (
      !((await text(page, "workflow-step-0-essence")) ?? "").includes(
        "GET /users · Example API Demo",
      )
    )
      throw new Error(`${where}: the request row lacks method, path or connector`);
    if (await page.getByTestId("workflow-step-0-configuration").count())
      throw new Error(`${where}: a step stands open before anyone asked`);
    await page.getByTestId("workflow-step-0-toggle").click();
    const configuration =
      (await page.getByTestId("workflow-step-0-configuration").textContent()) ?? "";
    for (const part of [
      "GET /users",
      '"limit": 10',
      "Accept: application/json",
      "Authorization: •••",
      // A reference is what the step is configured with: byte for byte.
      "X-Api-Key: {{credentials.api_key}}",
    ])
      if (!configuration.includes(part))
        throw new Error(`${where}: the request's configuration lacks "${part}"`);
    if (configuration.includes("plain-secret-token"))
      throw new Error(`${where}: a literal secret in a header shows its value`);
    await page.getByTestId("workflow-step-2-toggle").click();
    // Read from the document, not from the layout: a block below the fold is
    // not laid out yet, and its text is there all the same.
    const expression =
      (await page
        .getByTestId("workflow-step-2-configuration")
        .locator("pre")
        .first()
        .textContent()) ?? "";
    // Payload in a fenced block is shown unaltered — the identifier whole.
    if (!expression.includes(CALLED))
      throw new Error(`${where}: an identifier inside an expression was rewritten: ${expression}`);
    await page.getByTestId("workflow-steps").scrollIntoViewIfNeeded();
    await capture("workflow-steps-open");

    // Every identifier on the page is inside a fenced block, nowhere else.
    await assertNoVisibleUuids(page.getByTestId("detail-workflows"), where);

    // ── Technische Angaben: folded, one home for each fact ──────────────────
    if (await page.getByTestId("workflow-technical-slug").count())
      throw new Error(`${where}: the technical facts stand open`);
    await page.getByTestId("workflow-technical-toggle").click();
    if ((await text(page, "workflow-technical-slug")) === null)
      throw new Error(`${where}: the technical facts do not open`);
    if (!((await text(page, "workflow-technical-version")) ?? "").includes("v9"))
      throw new Error(`${where}: the technical facts lack the version`);

    // ── The further actions are a real menu ──────────────────────────────────
    await page.getByTestId("workflow-menu").click();
    for (const entry of ["change", "ask", "rename"])
      await page.getByTestId(`workflow-menu-${entry}`).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");

    // ── The grant: where the reader stands, and the state after it ──────────
    await page.getByTestId("detail-action").click();
    await page.getByTestId("authority-grant-review").waitFor({ timeout: 15_000 });
    if (state.previews < 1) throw new Error(`${where}: the title action opened no review`);
    await page.getByTestId("authority-grant-cancel").click();
    await page.getByTestId("authority-grant-cancel").waitFor({ state: "hidden" });
    await page.getByTestId("workflow-automation-action").click();
    await page.getByTestId("authority-grant-review").waitFor({ timeout: 15_000 });
    await page
      .waitForFunction(
        () => {
          const node = document.querySelector('[data-testid="authority-grant-confirm"]');
          return Boolean(node) && !node.disabled;
        },
        { timeout: 60_000 },
      )
      .catch(() => {});
    await page.getByTestId("authority-grant-confirm").click();
    await page.getByTestId("authority-grant-cancel").waitFor({ state: "hidden" });
    if (state.grants.length !== 1 || state.grants[0].execution_environment !== "prod")
      throw new Error(`${where}: the grant was ${JSON.stringify(state.grants)}`);
    where = at("after the grant");
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="workflow-automation"]')
          ?.getAttribute("data-state") === "approved",
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForLoadState("networkidle");
    panel = page.getByTestId("workflow-automation");
    // No approval button, no badge — and the title back to its ordinary action.
    await expectState(page, panel, where, words, "approved", {
      action: words.view,
      title: words.change,
    });
    const body = await page.getByTestId("detail-workflows").innerText();
    if (body.includes(words.approve))
      throw new Error(`${where}: an approved workflow still offers "${words.approve}"`);
    const approvedLine = (await text(page, "workflow-automation-headline")) ?? "";
    for (const part of ["v9", "28", "30"])
      if (!approvedLine.includes(part))
        throw new Error(`${where}: the headline lacks "${part}": ${approvedLine}`);
    await page.getByTestId("workflow-invocation-tab-webhook").click();
    if ((await text(page, "workflow-invocation-hook-0-state")) !== words.active)
      throw new Error(`${where}: the hook still reads as waiting`);
    await page.getByTestId("workflow-invocation-tab-http").click();
    await page.getByTestId("workflow-invocation-environment").click();
    await page.getByTestId("workflow-invocation-environment-prod").click();
    if (await page.getByTestId("workflow-invocation-preview-only").count())
      throw new Error(`${where}: an approved call is still called a trial run`);
    await capture("workflow-page-after-grant");

    // A link from elsewhere that names the panel lands on it.
    // From another page: a change of the hash alone is no navigation.
    await stand.visit(page, "workflows");
    await stand.visit(page, `workflows/${WORKFLOW}#workflow-automation`);
    await page.getByTestId("workflow-automation-state").waitFor();
    const landing = await page.getByTestId("workflow-automation").boundingBox();
    const viewport = page.viewportSize();
    if (!landing || !viewport || landing.y < 0 || landing.y > viewport.height / 2)
      throw new Error(`${where}: a link to the panel lands at ${JSON.stringify(landing)}`);

    // ── Freigegeben, on a fresh page: the approval behind "Freigabe ansehen" ─
    where = at("approved");
    panel = await open(page, stand, state, "approved");
    await expectState(page, panel, where, words, "approved", {
      action: words.view,
      title: words.change,
    });
    if (await page.getByTestId("workflow-automation-secondary").count())
      throw new Error(`${where}: an approval far from its end offers extending`);
    if (await page.getByTestId("authority-current").count())
      throw new Error(`${where}: the approval stands open before anyone asked`);
    await page.getByTestId("workflow-automation-action").click();
    const current = page.getByTestId("authority-current");
    await current.waitFor();
    if ((await current.getByTestId("authority-headline").getAttribute("title")) !== GRANT)
      throw new Error(`${where}: the current approval is not the one the state rests on`);
    // The other approval a run could use is listed with it, not as history.
    await page.getByTestId("authority-valid-1").waitFor();
    if (await current.getByTestId("authority-version").count())
      throw new Error(`${where}: the checksum and window stand open before anyone asked`);
    await current.getByTestId("authority-current-details").click();
    await current.getByTestId("authority-version").waitFor();
    await assertNoVisibleUuids(panel, where);
    await capture("workflow-page-approved");
    // History is folded, and holds only what no longer admits a run.
    await page.getByTestId("workflow-former-grants-toggle").click();
    await page.getByTestId("authority-history-0").waitFor();
    if (await page.getByTestId("authority-history-1").count())
      throw new Error(`${where}: a still-valid approval is filed under the earlier ones`);

    // An approval about to run out offers extending — beside looking at it.
    state.expiring = true;
    panel = await open(page, stand, state, "approved");
    if ((await text(page, "workflow-automation-secondary")) !== words.extend)
      throw new Error(`${at("expiring")}: an approval running out does not offer extending`);
    state.expiring = false;

    // ── Reparatur nötig: the diagnosis block's own act, and the title's ──────
    where = at("repair");
    panel = await open(page, stand, state, "repair");
    await expectState(page, panel, where, words, "repair", { action: null, title: words.repair });
    await panel.getByTestId("workflow-diagnosis-0-repair").waitFor();
    if ((await panel.getByTestId("workflow-diagnosis").count()) !== 1)
      throw new Error(`${where}: the diagnosis is not embedded in the panel exactly once`);
    if ((await page.getByTestId("workflow-diagnosis").count()) !== 1)
      throw new Error(`${where}: the diagnosis stands on the page a second time`);
    // The approval exists and no longer fits: it stays one press away.
    if ((await text(page, "workflow-automation-secondary")) !== words.view)
      throw new Error(`${where}: the existing approval cannot be looked at`);
    await capture("workflow-page-repair");
    // The engine lists a stored approval; the panel does not show "approved".
    // The call block follows the panel and promises no live run.
    await page.getByTestId("workflow-invocation-tab-http").click();
    const unconfirmed = page.getByTestId("workflow-invocation-preview-only");
    if ((await unconfirmed.getAttribute("data-verdict")) !== "unconfirmed")
      throw new Error(
        `${where}: a call under an approval that no longer fits reads as "${await unconfirmed.getAttribute("data-verdict")}"`,
      );
    if (!(await unconfirmed.innerText()).includes(words.unconfirmed))
      throw new Error(`${where}: the call line reads "${await unconfirmed.innerText()}"`);
    await page.getByTestId("workflow-invocation").scrollIntoViewIfNeeded();
    await capture("workflow-call-unconfirmed");

    // ── Altes Format: said plainly, no run offered, the one way out ─────────
    where = at("legacy");
    state.legacy = true;
    panel = await open(page, stand, state, "approved");
    if ((await panel.getAttribute("data-state")) !== "legacy")
      throw new Error(`${where}: the panel is in "${await panel.getAttribute("data-state")}"`);
    if ((await text(page, "workflow-automation-state")) !== words.states.legacy)
      throw new Error(
        `${where}: the state reads "${await text(page, "workflow-automation-state")}"`,
      );
    if (await page.getByTestId("workflow-run-open").count())
      throw new Error(`${where}: a run the engine refuses is still offered`);
    const legacyFilled = await page
      .getByTestId("detail-workflows")
      .locator('button[data-variant="default"], a[data-variant="default"]')
      .allInnerTexts();
    if (legacyFilled.length !== 1 || legacyFilled[0].trim() !== words.fixInChat)
      throw new Error(`${where}: the filled actions are ${JSON.stringify(legacyFilled)}`);
    const fix = await page.getByTestId("detail-action").getAttribute("href");
    if (!fix?.includes(`workflow_id=${WORKFLOW}`) || !fix.includes("prompt="))
      throw new Error(`${where}: the way out loses the workflow or the task: ${fix}`);
    // No approval is offered for a version the engine would refuse to approve.
    if (await panel.locator("button", { hasText: words.approve }).count())
      throw new Error(`${where}: an approval is offered for a version that cannot run`);
    if (await page.getByTestId("workflow-diagnosis").count())
      throw new Error(`${where}: the gate is asked about a version it never judges`);
    await page.getByTestId("workflow-invocation-tab-http").click();
    if (
      (await page.getByTestId("workflow-invocation-preview-only").getAttribute("data-verdict")) !==
      "refused"
    )
      throw new Error(`${where}: the call block does not say the call is refused`);
    await assertNoVisibleUuids(page.getByTestId("detail-workflows"), where);
    await capture("workflow-page-legacy");
    state.legacy = false;

    // ── Lists the reader may not see: said, never shown as "none" ────────────
    where = at("hidden lists");
    state.hiddenLists = true;
    panel = await open(page, stand, state, "grant");
    const visibleTabs = await page
      .locator('[data-testid^="workflow-invocation-tab-"]')
      .allInnerTexts();
    if (visibleTabs.join("|") !== [words.tabs.http, words.tabs.mcp, words.tabs.cli].join("|"))
      throw new Error(`${where}: the call tabs are ${JSON.stringify(visibleTabs)}`);
    const hiddenLine = (await text(page, "workflow-invocation-hidden")) ?? "";
    if (!hiddenLine.includes(words.hidden))
      throw new Error(`${where}: hidden lists are passed over in silence: "${hiddenLine}"`);
    // The panel still says what it knows: the hook and the schedule wait.
    if ((await panel.getAttribute("data-state")) !== "grant")
      throw new Error(`${where}: the panel is in "${await panel.getAttribute("data-state")}"`);
    await page.getByTestId("workflow-invocation").scrollIntoViewIfNeeded();
    await capture("workflow-call-hidden");
    state.hiddenLists = false;

    // ── Übernahme nötig: the saved change is what is reviewed ───────────────
    where = at("apply");
    panel = await open(page, stand, state, "apply");
    await expectState(page, panel, where, words, "apply", {
      action: words.review,
      title: words.review,
    });
    const applying = (await text(page, "workflow-automation-headline")) ?? "";
    if (!applying.includes("v10") || !applying.includes("v9"))
      throw new Error(`${where}: the headline lacks both versions: ${applying}`);
    await capture("workflow-page-apply");

    // ── Pausiert, only a hook: a line that says so, and no dead button ──────
    where = at("paused hook");
    state.hookOnly = true;
    panel = await open(page, stand, state, "paused");
    await expectState(page, panel, where, words, "paused", { action: null, title: words.change });
    const hookOff = (await text(page, "workflow-automation-hook-off")) ?? "";
    if (!/webhook/i.test(hookOff))
      throw new Error(`${where}: a switched-off hook is not explained: "${hookOff}"`);
    if (await panel.locator("button", { hasText: words.resume }).count())
      throw new Error(`${where}: a hook that cannot be resumed offers resuming`);
    await capture("workflow-page-paused-hook");
    state.hookOnly = false;

    // ── Pausiert: resuming is the one act ────────────────────────────────────
    where = at("paused");
    panel = await open(page, stand, state, "paused");
    await expectState(page, panel, where, words, "paused", {
      action: words.resume,
      title: words.resume,
    });
    await capture("workflow-page-paused");
    await page.getByTestId("workflow-automation-action").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="workflow-automation"]')
          ?.getAttribute("data-state") === "grant",
      undefined,
      { timeout: 15_000 },
    );
    if (state.resumed.length !== 1 || state.resumed[0].paused !== false)
      throw new Error(`${where}: resuming sent ${JSON.stringify(state.resumed)}`);

    // ── Auf Abruf: calm — nothing asks for the approval beside the title ─────
    where = at("manual");
    panel = await open(page, stand, state, "manual");
    await expectState(page, panel, where, words, "manual", {
      action: words.approve,
      title: words.change,
    });
    if (await page.getByTestId("workflow-automation-triggers").count())
      throw new Error(`${where}: a workflow nothing starts names a trigger`);
    const manualTabs = await page
      .locator('[data-testid^="workflow-invocation-tab-"]')
      .allInnerTexts();
    if (manualTabs.join("|") !== [words.tabs.http, words.tabs.mcp, words.tabs.cli].join("|"))
      throw new Error(`${where}: the call tabs are ${JSON.stringify(manualTabs)}`);
    if (await page.getByTestId("workflow-input-webhook").count())
      throw new Error(`${where}: a workflow without a hook explains the hook's body`);
    await capture("workflow-page-manual");

    // ── No public address configured: the path, and no invented host ────────
    where = at("no address");
    state.address = false;
    await open(page, stand, state, "manual");
    await page.getByTestId("workflow-invocation-no-address").waitFor();
    const path = (await text(page, "workflow-invocation-http-url")) ?? "";
    if (!path.includes("/v1/executions") || path.includes("http"))
      throw new Error(`${where}: the address reads "${path}"`);
    if (await page.getByTestId("workflow-invocation-snippet").count())
      throw new Error(`${where}: a call was rendered without an address`);
    const bodyBlock = await page
      .getByTestId("workflow-invocation-body")
      .locator("pre")
      .first()
      .textContent();
    if (!bodyBlock.includes(WORKFLOW) || !bodyBlock.includes('"source": "saved"'))
      throw new Error(`${where}: the request body is not shown`);
    await assertNoVisibleUuids(page.getByTestId("detail-workflows"), where);
    await capture("workflow-call-no-address");
  } finally {
    await page.unroute(isPageApi, handler);
    // Leave the page as it was found: this stand filled the client's cache.
    await stand.visit(page, "workflows");
  }
}

/** Open one entry of the further actions beside a workflow's title. */
export async function openWorkflowMenuEntry(page, entry) {
  await page.getByTestId("workflow-menu").click();
  await page.getByTestId(`workflow-menu-${entry}`).click();
}
