import { assertSingleTriggers } from "./cockpit-single-trigger.mjs";
import { assertNoVisibleUuids } from "./cockpit-visible-uuids.mjs";

export const WORKFLOW = "d2f4a6c8-1b3d-4e5f-8a7b-9c0d1e2f3a41";
const VERSION = "7e9a1c3b-5d2f-4b46-9e80-1a3c5e7f9b52";
const DRAFT = "3b5d7f91-2a4c-4e68-b0c2-4e6a8c0e2f63";
const SCHEDULE = "9c1e3a5b-7d4f-4a26-8b13-6f8a0c2e4d74";
const DEV_SCHEDULE = "2e4a6c8d-1f3b-4d57-9a02-7b9d1f3a5c16";
const REPAIR_CANDIDATE = "a8c0e2f4-6b1d-4f39-8c5e-0d2f4a6c8e27";
const HOOK = "5a7c9e1f-3b2d-4f48-a6c0-8e0a2c4e6b85";
const HTTP_CONNECTOR = "1f3b5d7c-9e4a-4c26-b813-2f4b6d8e0a96";
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
const FAILED_RUN = "c3e5a7b9-2d4f-4a61-8c03-5e7a9c1b3d04";

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
    invalid: Boolean(state.invalid),
    current_version: 9,
    current_version_id: VERSION,
    draft_version_id: state.scenario === "apply" ? DRAFT : VERSION,
    health_state: state.failedWith ? "degraded" : "ok",
    health_reason: state.failedWith ? "2 consecutive failures" : null,
    health_changed_at: state.failedWith ? "2026-08-10T07:00:00.000Z" : null,
    created_at: "2026-06-01T08:00:00.000Z",
    updated_at: "2026-08-10T09:00:00.000Z",
    last_executed_at: "2026-08-10T07:00:00.000Z",
    input_schema: INPUT_SCHEMA,
    output_schema: OUTPUT_SCHEMA,
    trigger: null,
    schedule: null,
    webhooks_active:
      state.scenario === "manual" || state.scenario === "paused" || state.scheduleOnly ? 0 : 1,
    effective_trigger: {
      kind: state.scenario === "manual" ? "request" : "webhook",
      source: state.scenario === "manual" ? "default" : "binding",
      state: "active",
    },
    steps: state.noSteps
      ? []
      : [
          {
            id: "fetch_data",
            kind: "request",
            method: "GET",
            path: "/users",
            connector_id: HTTP_CONNECTOR,
            query: { limit: 10 },
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
    invalid: Boolean(state.invalid),
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
    open_ended: false,
    inherited_from: null,
    superseded_by: null,
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
  if (state.devPending) return [authority(), revoked];
  const posted = state.granted?.visit === state.visit ? state.granted.body : null;
  const granted = posted
    ? {
        valid_from: posted.valid_from,
        valid_until: posted.valid_until,
        max_runs: posted.max_runs,
        remaining_runs: posted.max_runs,
        reserved_runs: 0,
        created_at: new Date().toISOString(),
      }
    : {};
  if (state.scenario === "manual" && posted) return [authority(granted), revoked];
  if (state.scenario === "approved" || state.scenario === "repair")
    return [
      authority(
        posted
          ? granted
          : state.untilRevoked
            ? {
                valid_until: null,
                max_runs: null,
                remaining_runs: null,
                reserved_runs: 41,
                open_ended: true,
              }
            : state.expiring
              ? { remaining_runs: 1, reserved_runs: 29 }
              : {},
      ),
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
      ? [
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
    if (path === "/v1/identity/api-keys")
      return json(route, {
        items: state.noKeys ? [] : [{ id: CREATOR, name: "ci-deploy", revoked_at: null }],
      });
    if (path === `/v1/workflows/${WORKFLOW}/draft`) {
      const waiting = state.scenario === "apply";
      return json(route, {
        workflow_id: WORKFLOW,
        version_id: waiting ? DRAFT : VERSION,
        current_version_id: VERSION,
        version: waiting ? 10 : 9,
        definition: {
          name: "Example API Demo Fetch",
          steps: waiting
            ? [...record(state).steps, { id: "notify_team", kind: "wait", duration_ms: 60_000 }]
            : record(state).steps,
        },
      });
    }
    if (path === `/v1/workflows/${WORKFLOW}/automation-status`)
      return json(route, automationStatus(state));
    if (path === `/v1/workflows/${WORKFLOW}/diagnosis`) {
      state.diagnosed.push(url.searchParams.get("environment"));
      if (state.diagnosisFails) return json(route, { error: "unavailable" }, 500);
      return json(route, diagnosis(state));
    }
    if (path === `/v1/workflows/${WORKFLOW}/execution-authorities`) {
      if (request.method() === "POST") {
        state.grants.push(request.postDataJSON());
        state.granted = { body: request.postDataJSON(), visit: state.visit };
        if (state.scenario !== "manual") state.scenario = "approved";
        return json(route, authorities(state)[0], 201);
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
          { id: HTTP_CONNECTOR, display_name: "Example API Demo" },
          { id: MAIL_CONNECTOR, display_name: "Mail" },
        ],
        total: 2,
      });
    if (path === "/v1/executions" && url.searchParams.get("workflow_id") === WORKFLOW) {
      const items = state.failedWith ? [failedRun(state.failedWith)] : [];
      return json(route, { items, total: items.length });
    }
    if (path === "/v1/patch-candidates") return json(route, { items: [], total: 0 });
    return route.fallback();
  };
}

export const isPageApi = (url) => {
  const { pathname, searchParams } = new URL(url);
  return (
    pathname.includes(WORKFLOW) ||
    pathname.startsWith("/v1/schedules") ||
    pathname === "/v1/connectors" ||
    pathname === "/v1/identity/api-keys" ||
    (["/v1/executions", "/v1/patch-candidates"].includes(pathname) &&
      searchParams.get("workflow_id") === WORKFLOW)
  );
};

function failedRun(causeClass) {
  return {
    id: FAILED_RUN,
    workflow_id: WORKFLOW,
    workflow_name: "Example API Demo Fetch",
    workflow_version_id: VERSION,
    hold_writes: false,
    source_kind: "saved",
    source_ref: null,
    status: "failed",
    request_source: "scheduler",
    parent_execution_id: null,
    started_at: "2026-08-10T07:00:00.000Z",
    finished_at: "2026-08-10T07:00:04.000Z",
    created_at: "2026-08-10T07:00:00.000Z",
    failure: { step_key: "send_email", cause_class: causeClass },
  };
}

const WORDS = {
  de: {
    states: {
      grant: "Gestoppt",
      approved: "Läuft",
      repair: "Reparatur nötig",
      apply: "Wartet auf Freigabe",
      paused: "Pausiert",
      manual: "Nicht freigegeben",
      invalid: "Altes Format",
      unknown: "Nicht geprüft",
      failing: "Schlägt fehl",
    },
    recheck: "Erneut prüfen",
    fixInChat: "Im Chat beheben",
    unconfirmed: "nicht bestätigt",
    hidden: "darfst du nicht sehen",
    approve: "Freigeben…",
    extend: "Verlängern…",
    review: "Änderung prüfen",
    resume: "Fortsetzen",
    cause: "Ursache ansehen",
    repair: "Automatisch reparieren",
    change: "Im Chat ändern",
    run: "Ausführen",
    required: "Pflicht",
    previewOnly: "Ohne Freigabe läuft nur ein Probelauf ohne Wirkung.",
    bearer: "API-Schlüssel als Bearer-Token",
    noAddress: "keine öffentliche Adresse",
    where: "Die Eingabe steht im Body unter „input“. Query-Parameter gibt es nicht.",
    webhookBody: "input.body",
    tabs: { http: "HTTP", webhook: "Webhook", mcp: "MCP", schedule: "Zeitplan", cli: "CLI" },
    branch: "wenn fetch_data.status = 200 → shape_success, sonst shape_failure",
    connector: "Konnektor",
    bodyInvalid: "Der Inhalt ist kein gültiges JSON.",
    savedVersion: "Gespeichert, noch nicht aktiv",
    noSteps: "Noch keine Schritte",
    daily: "täglich um 07:00",
    waiting: "Wartet auf Freigabe",
    active: "Aktiv",
  },
  en: {
    states: {
      grant: "Stopped",
      approved: "Running",
      repair: "Repair needed",
      apply: "Waiting for approval",
      paused: "Paused",
      manual: "Not approved",
      invalid: "Outdated format",
      unknown: "Not verified",
      failing: "Failing",
    },
    recheck: "Check again",
    fixInChat: "Fix it in the chat",
    unconfirmed: "not confirmed",
    hidden: "may not see",
    approve: "Approve…",
    extend: "Extend…",
    review: "Review change",
    resume: "Resume",
    cause: "View cause",
    repair: "Repair automatically",
    change: "Change in chat",
    run: "Run",
    required: "required",
    previewOnly: "Without approval this is only a trial run without effect.",
    bearer: "API key as bearer token",
    noAddress: "No public address",
    where: "Input goes in the request body under “input”. There are no query parameters.",
    webhookBody: "input.body",
    tabs: { http: "HTTP", webhook: "Webhook", mcp: "MCP", schedule: "Schedule", cli: "CLI" },
    branch: "if fetch_data.status = 200 → shape_success, else shape_failure",
    connector: "Connector",
    bodyInvalid: "The body is not valid JSON.",
    savedVersion: "Saved, not active yet",
    noSteps: "No steps yet",
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

async function fieldValue(page, testId) {
  const input = page.locator(`input[data-testid="${testId}"]`);
  if (!(await input.count())) return null;
  return (await input.first().inputValue()).trim();
}

async function rowLink(page, collection, index) {
  const desktop = page.getByTestId(`${collection}-row-link-${index}`);
  if (await desktop.isVisible().catch(() => false)) return desktop;
  return page.getByTestId(`${collection}-mobile-row-link-${index}`);
}

export async function openTab(page, tab) {
  await page.getByTestId(`workflow-tabs-tab-${tab}`).click();
  await page.waitForFunction(
    (value) => new URL(window.location.href).searchParams.get("tab") === value,
    tab === "verwenden" ? null : tab,
  );
}

export async function open(page, stand, state, scenario) {
  state.scenario = scenario;
  state.visit = (state.visit ?? 0) + 1;
  await stand.visit(page, `workflows/${WORKFLOW}`);
  const panel = page.getByTestId("workflow-automation");
  await page
    .getByTestId("workflow-automation-state")
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  return panel;
}

async function headerTriggers(page) {
  return page
    .locator('[data-slot="page-actions"]')
    .locator('button, a[href], [role="button"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
}

async function expectState(
  page,
  panel,
  where,
  words,
  scenario,
  { action, openers, stripState = words.states[scenario], runnable = true },
) {
  const dataState = await panel.getAttribute("data-state");
  if (dataState !== scenario) throw new Error(`${where}: the strip is in "${dataState}"`);
  const said = await text(page, "workflow-automation-state");
  if (said !== stripState)
    throw new Error(`${where}: the state reads "${said}", not "${stripState}"`);
  const actions = page.getByTestId("workflow-automation-action");
  if ((await actions.count()) !== (action ? 1 : 0))
    throw new Error(`${where}: the strip offers ${await actions.count()} actions`);
  if (action && (await text(page, "workflow-automation-action")) !== action)
    throw new Error(
      `${where}: the strip's action reads "${await text(page, "workflow-automation-action")}", not "${action}"`,
    );
  const beside = await headerTriggers(page);
  const expected = runnable
    ? "workflow-menu-change|workflow-menu|workflow-run-open"
    : "workflow-menu-change|workflow-menu";
  if (beside.join("|") !== expected)
    throw new Error(`${where}: beside the title stand ${JSON.stringify(beside)}`);
  const jumps = await page.getByTestId("detail-workflows").locator('a[href*="#"]').count();
  if (jumps) throw new Error(`${where}: the page carries ${jumps} jump link(s)`);
  await assertSingleTriggers(page, where, { approvalOpeners: openers });
  const filled = await page
    .getByTestId("detail-workflows")
    .locator('button[data-variant="default"], a[data-variant="default"]')
    .allInnerTexts();
  if (runnable ? filled.length !== 1 || filled[0].trim() !== words.run : filled.length !== 0)
    throw new Error(`${where}: the filled actions are ${JSON.stringify(filled)}`);
  for (const gone of [
    "authority-schedule-held",
    "authority-hook-held",
    "authority-grant-open",
    "workflow-cause",
    "agent-panel",
  ])
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
    let where = at("grant");
    let panel = await open(page, stand, state, "grant");
    await expectState(page, panel, where, words, "grant", { action: words.approve, openers: 1 });
    const approvals = await page
      .getByTestId("detail-workflows")
      .getByText(words.approve, { exact: true })
      .count();
    if (approvals !== 1)
      throw new Error(`${where}: "${words.approve}" stands ${approvals} times on the page`);
    if (state.previews !== 0)
      throw new Error(`${where}: opening the page ran ${state.previews} authority reviews`);
    if (state.diagnosed.some((environment) => environment !== "prod"))
      throw new Error(`${where}: a hook-started workflow was diagnosed in ${state.diagnosed}`);
    const headline = (await text(page, "workflow-automation-headline")) ?? "";
    if (!headline.includes(localeName === "de" ? "Produktion" : "Production"))
      throw new Error(`${where}: the headline lacks the environment: ${headline}`);
    const triggers = (await text(page, "workflow-automation-triggers")) ?? "";
    if (!triggers.includes(words.tabs.webhook) || !triggers.includes(words.tabs.schedule))
      throw new Error(`${where}: the triggers read "${triggers}"`);

    const tabs = await page
      .locator('[data-testid="workflow-tabs-list"] [role="tab"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
    if (
      tabs.join("|") !==
      ["verwenden", "verlauf", "aufbau", "freigaben"]
        .map((tab) => `workflow-tabs-tab-${tab}`)
        .join("|")
    )
      throw new Error(`${where}: the tabs are ${JSON.stringify(tabs)}`);
    for (const gone of ["workflow-tab-dag", "workflow-tab-overview", "detail-overview"])
      if (await page.getByTestId(gone).count())
        throw new Error(`${where}: the old "${gone}" is still on the page`);
    if (await page.locator('[data-family-slot="detail-context"]').count())
      throw new Error(`${where}: the "Steuerung" row is still on the page`);

    const kinds = await page.locator('[data-testid^="workflow-invocation-tab-"]').allInnerTexts();
    if (kinds.join("|") !== Object.values(words.tabs).join("|"))
      throw new Error(`${where}: the call kinds are ${JSON.stringify(kinds)}`);
    const landed = await page
      .locator('[data-testid^="workflow-invocation-tab-"][data-state="on"]')
      .getAttribute("data-testid");
    if (landed !== "workflow-invocation-tab-webhook")
      throw new Error(`${where}: a hook-started workflow lands on ${landed}`);
    const hookUrl = (await fieldValue(page, "workflow-invocation-hook-0-url")) ?? "";
    if (!hookUrl.includes(`${PUBLIC}/v1/hooks/${HOOK_SLUG}`))
      throw new Error(`${where}: the hook address reads "${hookUrl}"`);
    const signing = (await text(page, "workflow-invocation-hook-0-signing")) ?? "";
    for (const part of ["HMAC-SHA256", "{timestamp}.{body}", "x-example-signature"])
      if (!signing.includes(part)) throw new Error(`${where}: the signing line lacks ${part}`);
    if ((await text(page, "workflow-invocation-hook-0-state")) !== words.waiting)
      throw new Error(`${where}: a held hook is not shown as waiting`);
    if (await page.getByTestId("workflow-invocation-hook-0").locator("a, [data-opens]").count())
      throw new Error(`${where}: the held hook's row carries a trigger`);
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
    const httpUrl = (await fieldValue(page, "workflow-invocation-http-url")) ?? "";
    if (!httpUrl.includes(`${PUBLIC}/v1/executions`))
      throw new Error(`${where}: the call address reads "${httpUrl}"`);
    const block = page.getByTestId("workflow-invocation-snippet");
    const pre = block.locator("pre");
    if ((await pre.count()) !== 1) throw new Error(`${where}: the call is not in a code block`);
    let call = (await pre.textContent()) ?? "";
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
    if (!((await text(page, "workflow-invocation-http-method")) ?? "").includes("POST"))
      throw new Error(`${where}: the call does not name its method`);
    if (!((await text(page, "workflow-invocation-http-auth")) ?? "").includes(words.bearer))
      throw new Error(`${where}: the call does not say how it signs in`);
    if (await page.getByTestId("workflow-invocation-create-key").count())
      throw new Error(`${where}: a caller who holds a key is asked to create one`);
    await page.getByTestId("workflow-invocation-responses").hover();
    const tip = page.locator('[data-slot="tooltip-content"]');
    await tip.first().waitFor({ state: "visible" });
    const responses = await tip.first().innerText();
    for (const code of ["200", "202", "409"])
      if (!responses.includes(code)) throw new Error(`${where}: the responses lack ${code}`);
    await page.mouse.move(0, 0);
    const previewOnly = (await text(page, "workflow-invocation-preview-only")) ?? "";
    if (!previewOnly.includes(words.previewOnly))
      throw new Error(`${where}: an unapproved call is not said to be a trial run`);
    if (await page.getByTestId("workflow-invocation-preview-only").locator("a, button").count())
      throw new Error(`${where}: the trial-run line carries a trigger`);
    await assertSingleTriggers(page, `${where}, HTTP call`, { approvalOpeners: 1 });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByTestId("workflow-invocation-snippet-copy").click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    if (copied !== snippet("prod", "curl"))
      throw new Error(`${where}: copying did not hand over the call as shown`);
    await capture("workflow-call-http");
    await page.getByTestId("workflow-invocation-environment-dev").click();
    call = (await pre.textContent()) ?? "";
    if (!call.includes("x-subkit-environment: dev"))
      throw new Error(`${where}: choosing development did not change the call`);
    await page.getByTestId("workflow-invocation-language-python").click();
    if (!((await pre.textContent()) ?? "").includes("requests.post("))
      throw new Error(`${where}: choosing Python did not change the call`);

    await page.getByTestId("workflow-invocation-tab-mcp").click();
    const tool = (await fieldValue(page, "workflow-invocation-mcp-tool")) ?? "";
    if (tool !== `wf_${SLUG}`) throw new Error(`${where}: the tool name reads "${tool}"`);
    if (!((await text(page, "workflow-invocation-mcp-fallback")) ?? "").includes("run_workflow"))
      throw new Error(`${where}: the tool kind does not name the fallback`);
    await capture("workflow-call-mcp");

    await page.getByTestId("workflow-invocation-tab-schedule").click();
    await page.getByTestId("workflow-schedule").waitFor({ timeout: 10_000 });
    const scheduled = (await text(page, "workflow-schedule")) ?? "";
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
    const runsIn = (await text(page, "workflow-invocation-cli-environment")) ?? "";
    if (
      !runsIn.includes(localeName === "de" ? "Entwicklung" : "development") ||
      !runsIn.includes("HTTP")
    )
      throw new Error(`${where}: the command line does not say where it runs: "${runsIn}"`);

    if (await page.getByTestId("workflow-input").count())
      throw new Error(`${where}: input and output stand open before anyone asked`);
    await page.getByTestId("workflow-io-section-toggle").click();
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
    if (!required.includes(words.required))
      throw new Error(`${where}: the required field is not marked: ${required}`);
    const output = await page.getByTestId("workflow-output").innerText();
    for (const part of ["id", "threadId"])
      if (!output.includes(part)) throw new Error(`${where}: the output lacks "${part}"`);

    await openTab(page, "aufbau");
    await page.getByTestId("workflow-steps").waitFor();
    if ((await page.locator('[data-testid^="workflow-step-list-row-"]').count()) < 10)
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
    await (await rowLink(page, "workflow-step-list", 0)).click();
    const configuration =
      (await page.getByTestId("workflow-step-0-configuration").textContent()) ?? "";
    for (const part of [
      "GET /users",
      '"limit": 10',
      "Accept: application/json",
      "Authorization: •••",
      "X-Api-Key: {{credentials.api_key}}",
    ])
      if (!configuration.includes(part))
        throw new Error(`${where}: the request's configuration lacks "${part}"`);
    if (configuration.includes("plain-secret-token"))
      throw new Error(`${where}: a literal secret in a header shows its value`);
    await capture("workflow-steps-open");
    await page.getByTestId("workflow-step-0-close").click();
    await page.getByTestId("workflow-step-0-sheet").waitFor({ state: "hidden" });
    await (await rowLink(page, "workflow-step-list", 2)).click();
    const expression =
      (await page
        .getByTestId("workflow-step-2-configuration")
        .locator("pre")
        .first()
        .textContent()) ?? "";
    if (!expression.includes(CALLED))
      throw new Error(`${where}: an identifier inside an expression was rewritten: ${expression}`);
    await page.getByTestId("workflow-step-2-close").click();
    await page.getByTestId("workflow-step-2-sheet").waitFor({ state: "hidden" });

    const editStep = async (index) => {
      await page
        .getByTestId(`workflow-step-${index}-menu`)
        .filter({ visible: true })
        .first()
        .click();
      await page.getByTestId(`workflow-step-${index}-edit`).click();
      const dialog = page.getByTestId("step-dialog");
      await dialog.waitFor();
      return dialog;
    };
    const areaValue = (testId) => page.locator(`textarea[data-testid="${testId}"]`).inputValue();
    let dialog = await editStep(0);
    const dialogText = await dialog.innerText();
    if (
      !dialogText.includes(words.connector) ||
      (localeName === "de" && dialogText.includes("Connector"))
    )
      throw new Error(`${where}: the step editor does not say "${words.connector}"`);
    if (!(await areaValue("step-query")).includes('"limit": 10'))
      throw new Error(`${where}: the step editor does not show the query`);
    const headerValue = await areaValue("step-headers");
    if (
      !headerValue.includes("Accept: application/json") ||
      !headerValue.includes("Authorization: •••")
    )
      throw new Error(`${where}: the step editor's headers read "${headerValue}"`);
    if (headerValue.includes("plain-secret-token"))
      throw new Error(`${where}: the step editor shows a literal secret header`);
    await page.locator('textarea[data-testid="step-body"]').fill("{ to: ");
    await page.getByTestId("step-dialog-submit").click();
    if ((await text(page, "step-body-error")) !== words.bodyInvalid)
      throw new Error(`${where}: invalid JSON in the body is not named at the body`);
    await capture("workflow-step-editor-request");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    dialog = await editStep(1);
    if ((await fieldValue(page, "step-when")) !== "fetch_data.status = 200")
      throw new Error(`${where}: the branch condition is not editable`);
    if (
      !(await page.getByTestId("step-then-shape_success").isChecked()) ||
      !(await page.getByTestId("step-else-shape_failure").isChecked())
    )
      throw new Error(`${where}: the branch arms are not shown`);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    if (await page.getByTestId("step-savebar").count())
      throw new Error(`${where}: closing the step editor left unsaved changes`);

    await assertNoVisibleUuids(page.getByTestId("detail-workflows"), where);

    if (await page.getByTestId("workflow-technical-slug").count())
      throw new Error(`${where}: the technical facts stand open`);
    await page.getByTestId("workflow-technical-toggle").click();
    if ((await text(page, "workflow-technical-slug")) === null)
      throw new Error(`${where}: the technical facts do not open`);
    if (!((await text(page, "workflow-technical-version")) ?? "").includes("v9"))
      throw new Error(`${where}: the technical facts lack the version`);

    await page.getByTestId("workflow-menu").click();
    for (const entry of ["rename", "category"])
      await page.getByTestId(`workflow-menu-${entry}`).waitFor({ state: "visible" });
    if (await page.getByTestId("workflow-menu-ask").count())
      throw new Error(`${where}: the menu offers the chat a second time`);
    await page.keyboard.press("Escape");
    await page.getByTestId("workflow-menu-rename").waitFor({ state: "hidden" });

    await assertSingleTriggers(page, `${where}, sections open`, { approvalOpeners: 1 });

    await page.getByTestId("workflow-automation-action").click();
    await page.getByTestId("authority-grant-review").waitFor({ timeout: 15_000 });
    if (state.previews < 1) throw new Error(`${where}: the strip's action opened no review`);
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
      { timeout: 5_000 },
    );
    await page.waitForLoadState("networkidle");
    panel = page.getByTestId("workflow-automation");
    await expectState(page, panel, where, words, "approved", { action: null, openers: 0 });
    const body = await page.getByTestId("detail-workflows").innerText();
    if (body.includes(words.approve))
      throw new Error(`${where}: an approved workflow still offers "${words.approve}"`);
    const approvedLine = (await text(page, "workflow-automation-headline")) ?? "";
    const lastRun = localeName === "de" ? "Letzter Lauf" : "Last run";
    if (!approvedLine.includes(lastRun))
      throw new Error(`${where}: the headline does not say how the last run went: ${approvedLine}`);
    await openTab(page, "verwenden");
    await page.getByTestId("workflow-invocation-tab-webhook").click();
    if ((await text(page, "workflow-invocation-hook-0-state")) !== words.active)
      throw new Error(`${where}: the hook still reads as waiting`);
    await page.getByTestId("workflow-invocation-tab-http").click();
    await page.getByTestId("workflow-invocation-environment-prod").click();
    if (await page.getByTestId("workflow-invocation-preview-only").count())
      throw new Error(`${where}: an approved call is still called a trial run`);
    await capture("workflow-page-after-grant");

    await stand.visit(page, "workflows");
    await stand.visit(page, `workflows/${WORKFLOW}#workflow-automation`);
    await page.getByTestId("workflow-automation-state").waitFor();
    const landing = await page.getByTestId("workflow-automation").boundingBox();
    const viewport = page.viewportSize();
    if (!landing || !viewport || landing.y < 0 || landing.y > viewport.height / 2)
      throw new Error(`${where}: a link to the strip lands at ${JSON.stringify(landing)}`);

    where = at("approved");
    panel = await open(page, stand, state, "approved");
    await expectState(page, panel, where, words, "approved", { action: null, openers: 0 });
    await openTab(page, "freigaben");
    await page.getByTestId("workflow-approvals-summary").waitFor();
    if (await page.getByTestId("authority-headline").count())
      throw new Error(`${where}: an approval stands open before anyone asked`);
    if ((await page.locator('[data-testid^="workflow-approvals-row-"]').count()) < 2)
      throw new Error(`${where}: the approvals a run can use are not both listed`);
    await (await rowLink(page, "workflow-approvals", 0)).click();
    const sheet = page.getByTestId("authority-sheet");
    await sheet.waitFor();
    if (
      (await sheet
        .getByTestId("authority-headline")
        .locator("[title]")
        .first()
        .getAttribute("title")) !== GRANT
    )
      throw new Error(`${where}: the first approval is not the one the state rests on`);
    await sheet.getByTestId("authority-version").waitFor();
    await assertNoVisibleUuids(sheet, where);
    await capture("workflow-page-approved");
    await page.getByTestId("authority-sheet-close").click();
    await sheet.waitFor({ state: "hidden" });
    await assertSingleTriggers(page, `${where}, approvals`, { approvalOpeners: 0 });
    await page.getByTestId("workflow-former-grants-toggle").click();
    await page.getByTestId("workflow-former-approvals-row-0").waitFor({ state: "attached" });
    if (await page.getByTestId("workflow-former-approvals-row-1").count())
      throw new Error(`${where}: a still-valid approval is filed under the earlier ones`);

    state.expiring = true;
    panel = await open(page, stand, state, "approved");
    await expectState(page, panel, at("expiring"), words, "approved", {
      action: words.extend,
      openers: 1,
      stripState: localeName === "de" ? "Freigabe läuft ab" : "Approval running out",
    });
    await capture("workflow-page-expiring");
    state.expiring = false;

    where = at("unknown");
    state.diagnosisFails = true;
    panel = await open(page, stand, state, "approved");
    if ((await panel.getAttribute("data-state")) !== "unknown")
      throw new Error(`${where}: the strip is in "${await panel.getAttribute("data-state")}"`);
    if ((await text(page, "workflow-automation-state")) !== words.states.unknown)
      throw new Error(
        `${where}: the state reads "${await text(page, "workflow-automation-state")}"`,
      );
    if ((await text(page, "workflow-automation-recheck")) !== words.recheck)
      throw new Error(`${where}: the strip does not offer to check again`);
    await page.getByTestId("workflow-diagnosis-failed").waitFor();
    if (await page.getByTestId("workflow-diagnosis-failed-retry").count())
      throw new Error(`${where}: the failed diagnosis offers a second way to read again`);
    await assertSingleTriggers(page, where, { approvalOpeners: 0 });
    await capture("workflow-page-unknown");
    state.diagnosisFails = false;

    where = at("repair");
    panel = await open(page, stand, state, "repair");
    await expectState(page, panel, where, words, "repair", { action: null, openers: 0 });
    await page
      .getByTestId("workflow-diagnosis-0-repair")
      .filter({ visible: true })
      .first()
      .waitFor();
    const authorFix = page.getByTestId("workflow-diagnosis-1-chat").filter({ visible: true });
    if ((await authorFix.count()) !== 1 || (await authorFix.innerText()).trim() !== words.fixInChat)
      throw new Error(`${where}: the step that needs an author has no way to one`);
    if ((await page.getByTestId("workflow-diagnosis").count()) !== 1)
      throw new Error(`${where}: the diagnosis does not stand under the strip exactly once`);
    await capture("workflow-page-repair");
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

    where = at("unhealthy: approval");
    state.failedWith = "authority_mismatch";
    panel = await open(page, stand, state, "repair");
    await expectState(page, panel, where, words, "repair", { action: null, openers: 0 });
    await page.getByTestId("workflow-strip-more").waitFor();
    await openTab(page, "verlauf");
    const failedRow = await (await rowLink(page, "workflow-runs", 0)).getAttribute("href");
    if (
      !failedRow?.startsWith(`/cockpit/workflows/${WORKFLOW}?`) ||
      !failedRow.includes(`run=${FAILED_RUN}`)
    )
      throw new Error(`${where}: the failed run's row leads to ${failedRow}`);
    await capture("workflow-page-unhealthy");

    where = at("unhealthy: upstream");
    state.failedWith = "upstream_error";
    panel = await open(page, stand, state, "approved");
    await expectState(page, panel, where, words, "approved", {
      action: words.cause,
      openers: 0,
      stripState: words.states.failing,
    });
    await capture("workflow-page-unhealthy-upstream");
    await page.getByTestId("workflow-automation-action").click();
    await page.waitForFunction(
      (run) => new URL(window.location.href).searchParams.get("run") === run,
      FAILED_RUN,
    );
    if (new URL(page.url()).pathname !== `/cockpit/workflows/${WORKFLOW}`)
      throw new Error(`${where}: the cause left the workflow's page: ${page.url()}`);
    state.failedWith = null;

    where = at("invalid");
    state.invalid = true;
    panel = await open(page, stand, state, "approved");
    await expectState(page, panel, where, words, "invalid", {
      action: words.fixInChat,
      openers: 0,
      runnable: false,
    });
    if (await page.getByTestId("workflow-run-open").count())
      throw new Error(`${where}: a run the engine refuses is still offered`);
    const fix = await page.getByTestId("workflow-automation-action").getAttribute("href");
    if (!fix?.includes(`workflow_id=${WORKFLOW}`) || !fix.includes("prompt="))
      throw new Error(`${where}: the way out loses the workflow or the task: ${fix}`);
    if (await panel.locator("button", { hasText: words.approve }).count())
      throw new Error(`${where}: an approval is offered for a version that cannot run`);
    if (await page.getByTestId("workflow-diagnosis").count())
      throw new Error(`${where}: the gate is asked about a version it never judges`);
    await page.getByTestId("workflow-invocation-tab-http").click();
    if (
      (await page.getByTestId("workflow-invocation-preview-only").getAttribute("data-verdict")) !==
      "refused"
    )
      throw new Error(`${where}: the call does not say it is refused`);
    await assertNoVisibleUuids(page.getByTestId("detail-workflows"), where);
    await capture("workflow-page-invalid");
    state.invalid = false;

    where = at("hidden lists");
    state.hiddenLists = true;
    panel = await open(page, stand, state, "grant");
    const visibleKinds = await page
      .locator('[data-testid^="workflow-invocation-tab-"]')
      .allInnerTexts();
    if (
      visibleKinds.join("|") !==
      [words.tabs.http, words.tabs.mcp, words.tabs.schedule, words.tabs.cli].join("|")
    )
      throw new Error(`${where}: the call kinds are ${JSON.stringify(visibleKinds)}`);
    const hiddenLine = (await text(page, "workflow-invocation-hidden")) ?? "";
    if (!hiddenLine.includes(words.hidden))
      throw new Error(`${where}: hidden lists are passed over in silence: "${hiddenLine}"`);
    if ((await panel.getAttribute("data-state")) !== "grant")
      throw new Error(`${where}: the strip is in "${await panel.getAttribute("data-state")}"`);
    await page.getByTestId("workflow-invocation").scrollIntoViewIfNeeded();
    await capture("workflow-call-hidden");
    state.hiddenLists = false;

    where = at("apply");
    panel = await open(page, stand, state, "apply");
    await expectState(page, panel, where, words, "apply", { action: words.approve, openers: 1 });
    const applying = (await text(page, "workflow-automation-headline")) ?? "";
    if (!applying.includes("v10") || !applying.includes("v9"))
      throw new Error(`${where}: the headline lacks both versions: ${applying}`);
    await capture("workflow-page-apply");
    await openTab(page, "aufbau");
    await page.getByTestId("workflow-build-saved").waitFor();
    if ((await text(page, "workflow-build-saved")) !== words.savedVersion)
      throw new Error(`${where}: the saved version is not marked as not active yet`);
    const buildLine = (await text(page, "workflow-build-summary")) ?? "";
    if (!buildLine.includes("v10") || !buildLine.includes("11"))
      throw new Error(`${where}: the build tab does not show the saved version: "${buildLine}"`);
    await page
      .locator(
        '[data-testid="workflow-step-list-row-link-10"], [data-testid="workflow-step-list-mobile-row-link-10"]',
      )
      .filter({ visible: true })
      .first()
      .waitFor();
    await capture("workflow-build-saved-version");

    where = at("no steps");
    state.noSteps = true;
    panel = await open(page, stand, state, "grant");
    if ((await text(page, "workflow-automation-state")) !== words.noSteps)
      throw new Error(
        `${where}: a workflow without steps reads "${await text(page, "workflow-automation-state")}"`,
      );
    if (!(await page.getByTestId("workflow-run-open").isDisabled()))
      throw new Error(`${where}: a workflow without steps can be run`);
    if (await page.getByTestId("workflow-automation-action").count())
      throw new Error(`${where}: a workflow without steps offers an approval`);
    await capture("workflow-page-no-steps");
    state.noSteps = false;

    where = at("paused hook");
    state.hookOnly = true;
    panel = await open(page, stand, state, "paused");
    await expectState(page, panel, where, words, "paused", { action: null, openers: 0 });
    const hookOff = (await text(page, "workflow-automation-headline")) ?? "";
    if (!/webhook/i.test(hookOff))
      throw new Error(`${where}: a switched-off hook is not explained: "${hookOff}"`);
    if (await panel.locator("button", { hasText: words.resume }).count())
      throw new Error(`${where}: a hook that cannot be resumed offers resuming`);
    await capture("workflow-page-paused-hook");
    state.hookOnly = false;

    where = at("paused");
    panel = await open(page, stand, state, "paused");
    await expectState(page, panel, where, words, "paused", { action: words.resume, openers: 0 });
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

    where = at("manual");
    panel = await open(page, stand, state, "manual");
    await expectState(page, panel, where, words, "manual", { action: words.approve, openers: 1 });
    if (await page.getByTestId("workflow-automation-triggers").count())
      throw new Error(`${where}: a workflow nothing starts names a trigger`);
    const manualKinds = await page
      .locator('[data-testid^="workflow-invocation-tab-"]')
      .allInnerTexts();
    if (
      manualKinds.join("|") !==
      [words.tabs.http, words.tabs.mcp, words.tabs.schedule, words.tabs.cli].join("|")
    )
      throw new Error(`${where}: the call kinds are ${JSON.stringify(manualKinds)}`);
    await page.getByTestId("workflow-io-section-toggle").click();
    await page.getByTestId("workflow-input").waitFor();
    if (await page.getByTestId("workflow-input-webhook").count())
      throw new Error(`${where}: a workflow without a hook explains the hook's body`);
    await capture("workflow-page-manual");
    await page.getByTestId("workflow-menu").click();
    await page.getByTestId("workflow-menu-delete").click();
    const removal = (await text(page, "workflow-delete-confirm-consequence")) ?? "";
    if (/webhook|zeitplan|schedule/i.test(removal))
      throw new Error(
        `${where}: deleting names a starter the workflow does not have: "${removal}"`,
      );
    await page.getByTestId("workflow-delete-confirm-cancel").click();
    await page.getByTestId("workflow-delete-confirm").waitFor({ state: "hidden" });

    where = at("manual, just approved");
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
    await page
      .waitForFunction(
        () =>
          document
            .querySelector('[data-testid="workflow-automation"]')
            ?.getAttribute("data-state") === "approved",
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => {});
    const justApproved = (await text(page, "workflow-automation-state")) ?? "";
    if (justApproved === words.states.manual)
      throw new Error(`${where}: the approval just given still reads "${justApproved}"`);

    where = at("no address");
    state.address = false;
    state.noKeys = true;
    await open(page, stand, state, "manual");
    await page.getByTestId("workflow-invocation-no-address").waitFor();
    const createKey = page.getByTestId("workflow-invocation-create-key");
    await createKey.waitFor();
    if (
      !((await createKey.getAttribute("href")) ?? "").endsWith("/cockpit/api-access?section=keys")
    )
      throw new Error(`${where}: "create a key" does not lead to the keys`);
    const path = (await fieldValue(page, "workflow-invocation-http-url")) ?? "";
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
    await stand.visit(page, "workflows");
  }
}

export async function openWorkflowMenuEntry(page, entry) {
  await page.getByTestId("workflow-menu").click();
  await page.getByTestId(`workflow-menu-${entry}`).click();
}
