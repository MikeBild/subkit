import { assertSingleTriggers } from "./cockpit-single-trigger.mjs";
import { assertNoVisibleUuids } from "./cockpit-visible-uuids.mjs";

const HELD = "7a2c9e41-5d3b-4f86-a1e0-c4b8d2f6e913";
const UNAVAILABLE = "e3b5d7f9-1a2c-4e46-8b60-5d7f9a1c3e28";
const FAILED = "4f8a1c3e-6b2d-4a95-9e07-b1d3f5a7c942";
const PLAIN = "c6d8e0f2-3a4b-4c5d-9e6f-7a8b9c0d1e53";
const VERSION = "2b4d6f81-9a3c-4e5d-b7f0-1c3e5a7b9d64";
const MAIL_DEV = "8e0a2c4f-6b1d-4f37-a95c-3e5a7c9b1d76";
const EXPIRED_CONNECTOR = "5c7e9a1b-3d2f-4b68-8a04-6e8c0a2d4f87";
const HEALTHY_CONNECTOR = "9d1f3b5c-7e4a-4c26-b813-2f4b6d8e0a98";
const FAILED_RUN = "1a3c5e7f-9b2d-4f48-a6c0-8e0a2c4e6b19";

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const NAMES = {
  [HELD]: "finding-triage",
  [UNAVAILABLE]: "Tagesbericht versenden",
  [FAILED]: "Rechnungen abgleichen",
  [PLAIN]: "Wochenbericht",
};

function workflowRecord(id) {
  return {
    id,
    tenant_id: id,
    name: NAMES[id],
    slug: NAMES[id].toLowerCase().replaceAll(" ", "-"),
    description: null,
    lifecycle: "active",
    current_version: 3,
    current_version_id: VERSION,
    draft_version_id: VERSION,
    health_state: "ok",
    health_reason: null,
    health_changed_at: null,
    steps: [{ id: "send", name: "Senden", kind: "request" }],
    updated_at: "2026-08-10T09:00:00.000Z",
  };
}

function connectorRecord(id, expired) {
  return {
    id,
    tenant_id: id,
    slug: expired ? "mail" : "lager-api",
    display_name: expired ? "Mail" : "Lager-API",
    description: null,
    driver: "http",
    environment: "dev",
    auth_type: expired ? "oauth2" : "none",
    sign_in: expired ? { kind: "oauth", start: `/v1/connectors/${id}/oauth/start` } : null,
    base_url: expired ? "https://mail.example.com" : "https://lager.example.org/api",
    dsn: null,
    config: {},
    operator_quirks: {},
    template_slug: null,
    template_name: null,
    template_source: null,
    template_version: null,
    template_snapshot: null,
    enabled: true,
    last_error: null,
    health_state: expired ? "needs_reauth" : "ok",
    health_reason: null,
    health_error_code: null,
    needs_reauth: expired,
    auth_failed_at: expired ? "2026-07-23T08:00:00.000Z" : null,
    auth_failed_reason: expired ? "invalid_grant" : null,
    created_at: "2026-06-01T08:00:00.000Z",
    updated_at: "2026-07-23T08:00:00.000Z",
  };
}

function preview(workflowId, environment) {
  const blocked = workflowId === UNAVAILABLE && environment === "dev";
  return {
    manifest: {
      schema_version: 1,
      workflow_id: workflowId,
      workflow_version_id: VERSION,
      execution_environment: environment,
      effects: [],
      issues: [],
    },
    digest: "b".repeat(64),
    eligible_for_repeated_runs: !blocked,
    unavailable_steps: blocked ? ["send"] : [],
    unavailable_connectors: blocked
      ? [
          {
            step_id: "send",
            connector_id: MAIL_DEV,
            connector_slug: "mail",
            connector_name: "Mail",
            reason: "needs_reauth",
          },
        ]
      : [],
    execution_shape: { requests: [], iterations: [], run_limit_is_request_limit: false },
    schedules: [],
    suggested_bounds: {
      valid_from: "2026-08-10T09:00:00.000Z",
      valid_until: "2026-08-11T09:00:00.000Z",
      max_runs: 1,
    },
    suggested_bounds_basis: { kind: "manual" },
  };
}

function runs(workflowId) {
  const at = (minutes) => new Date(Date.parse("2026-08-10T09:00:00.000Z") - minutes * 60_000);
  const row = (id, status, minutes) => ({
    id,
    workflow_id: workflowId,
    workflow_name: NAMES[workflowId],
    workflow_version_id: VERSION,
    hold_writes: false,
    source_kind: "saved",
    source_ref: null,
    status,
    request_source: "scheduler",
    parent_execution_id: null,
    started_at: at(minutes).toISOString(),
    finished_at: at(minutes - 1).toISOString(),
    created_at: at(minutes).toISOString(),
    failure: status === "failed" ? { step_key: "send", cause_class: "upstream_error" } : null,
  });
  const items =
    workflowId === FAILED
      ? [row(FAILED_RUN, "failed", 5), row(`${FAILED_RUN.slice(0, -2)}20`, "succeeded", 65)]
      : [
          row(`${workflowId.slice(0, -2)}01`, "succeeded", 5),
          row(`${workflowId.slice(0, -2)}02`, "failed", 65),
        ];
  return { items, total: items.length };
}

function detailApi(state) {
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    for (const id of [HELD, UNAVAILABLE, FAILED, PLAIN]) {
      if (path === `/v1/workflows/${id}`) return json(route, workflowRecord(id));
      if (path === `/v1/workflows/${id}/automation-status`)
        return json(route, {
          schedules: [],
          inbound_hooks:
            id === HELD
              ? [
                  {
                    inbound_hook_id: "0c2e4a6b-8d1f-4e37-9a50-b2d4f6a8c015",
                    workflow_id: id,
                    slug: "findings-inbox",
                    state: "approval_required",
                    ready: false,
                    environment: "prod",
                    admission_hold: {
                      reason_code: "execution_authority_required",
                      observed_at: "2026-08-10T08:30:00.000Z",
                    },
                    last_refused_at: "2026-08-10T08:30:00.000Z",
                    last_refused_reason: "execution_authority_required",
                  },
                ]
              : [],
        });
      if (path.startsWith(`/v1/workflows/${id}/versions/`) && path.endsWith("/authority-preview")) {
        state.previews += 1;
        return json(route, preview(id, url.searchParams.get("environment")));
      }
      if (path === `/v1/workflows/${id}/execution-authorities`)
        return json(route, { items: [], next_cursor: null });
      if (path === "/v1/executions" && url.searchParams.get("workflow_id") === id)
        return json(route, runs(id));
    }
    if (path === "/v1/schedules") return json(route, { schedules: [], total: 0 });
    if (path === `/v1/connectors/${EXPIRED_CONNECTOR}`)
      return json(route, connectorRecord(EXPIRED_CONNECTOR, true));
    if (path === `/v1/connectors/${HEALTHY_CONNECTOR}`)
      return json(route, connectorRecord(HEALTHY_CONNECTOR, false));
    if (path.endsWith("/credential") && path.includes(EXPIRED_CONNECTOR))
      return json(route, {
        mode: "oauth2",
        environment: "dev",
        connection: null,
        header_names: [],
        updated_at: "2026-06-01T08:00:00.000Z",
      });
    if (path.endsWith("/credential") && path.includes(HEALTHY_CONNECTOR)) return json(route, null);
    return route.fallback();
  };
}

const isDetailApi = (url) => {
  const { pathname, searchParams } = new URL(url);
  const ids = [HELD, UNAVAILABLE, FAILED, PLAIN, EXPIRED_CONNECTOR, HEALTHY_CONNECTOR];
  return (
    ids.some((id) => pathname.includes(id)) ||
    pathname === "/v1/schedules" ||
    (pathname === "/v1/executions" && ids.includes(searchParams.get("workflow_id") ?? ""))
  );
};

const STALE = ["Sicher im Chat fortsetzen", "Continue safely in chat"];

async function besideTitle(page) {
  return page
    .locator('[data-slot="page-actions"]')
    .locator('button, a[href], [role="button"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
}

async function expectWorkflowTitle(page, where) {
  await page.getByTestId("workflow-automation-state").waitFor({ timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  const beside = await besideTitle(page);
  if (beside.join("|") !== "workflow-menu-change|workflow-menu|workflow-run-open")
    throw new Error(`${where}: beside the title stand ${JSON.stringify(beside)}`);
  if (await page.getByTestId("detail-action").count())
    throw new Error(`${where}: the title carries a state's action`);
  const body = await page.locator("body").innerText();
  for (const stale of STALE)
    if (body.includes(stale)) throw new Error(`${where}: the page still offers "${stale}"`);
}

async function assertRecordHeader(page, where, de) {
  const found = await page.evaluate(() => ({
    strips: document.querySelectorAll('[data-slot="status-strip"]').length,
    titleBadges: document.querySelectorAll('[data-slot="page-title-row"] [data-slot="badge"]')
      .length,
    actions: [...document.querySelectorAll('[data-slot="page-actions"] [data-testid]')].map(
      (node) => node.getAttribute("data-testid"),
    ),
    body: document.body.innerText,
  }));
  for (const gone of de
    ? ["Steuerung", "Schritte im Chat", "Metadaten bearbeiten", "Nur lesend"]
    : ["Governance", "steps in the chat", "Edit metadata", "Read-only"])
    if (found.body.includes(gone)) throw new Error(`${where}: the page still says "${gone}"`);
  if (found.strips !== 1) throw new Error(`${where}: ${found.strips} status strips, not one`);
  if (found.titleBadges !== 0) throw new Error(`${where}: the state stands beside the title too`);
  if (!found.actions.includes("detail-action"))
    throw new Error(
      `${where}: the header lacks "Im Chat ändern" — ${JSON.stringify(found.actions)}`,
    );
  if (new Set(found.actions).size !== found.actions.length)
    throw new Error(`${where}: an action stands twice beside the title — ${found.actions}`);
}

export async function verifyDetailAction(page, stand, uuid, localeName, capture) {
  const de = localeName === "de";
  const state = { previews: 0 };
  const handler = detailApi(state);
  await page.route(isDetailApi, handler);
  try {
    let where = `/workflows/<held> (${localeName})`;
    await stand.visit(page, `workflows/${HELD}`);
    await expectWorkflowTitle(page, where);
    const approve = de ? "Freigeben…" : "Approve…";
    const panelAction = (await page.getByTestId("workflow-automation-action").innerText()).trim();
    if (panelAction !== approve) throw new Error(`${where}: the panel offers "${panelAction}"`);
    const offered = await page
      .getByTestId("detail-workflows")
      .getByText(approve, { exact: true })
      .count();
    if (offered !== 1) throw new Error(`${where}: "${approve}" stands ${offered} times`);
    if (await page.locator('a[href*="#workflow-"]').count())
      throw new Error(`${where}: something only links to a section of the page`);
    if (state.previews !== 0)
      throw new Error(`${where}: opening the page ran ${state.previews} authority reviews`);
    await assertSingleTriggers(page, where, { approvalOpeners: 1 });
    await assertNoVisibleUuids(page.locator("header").first(), where);
    await capture("detail-action-held");
    await page.getByTestId("workflow-automation-action").click();
    await page.getByTestId("authority-grant-cancel").waitFor({ state: "visible", timeout: 10_000 });
    if (state.previews < 1) throw new Error(`${where}: the action opened no review`);
    await page.getByTestId("authority-grant-cancel").click();
    await page.getByTestId("authority-grant-cancel").waitFor({ state: "hidden" });

    where = `/workflows/<unavailable> (${localeName})`;
    state.previews = 0;
    await stand.visit(page, `workflows/${UNAVAILABLE}`);
    await expectWorkflowTitle(page, where);
    if (state.previews !== 0)
      throw new Error(`${where}: opening the page ran ${state.previews} authority reviews`);
    await assertSingleTriggers(page, where);

    where = `/workflows/<failed> (${localeName})`;
    await stand.visit(page, `workflows/${FAILED}`);
    await expectWorkflowTitle(page, where);
    await page.getByTestId("workflow-tabs-tab-history").click();
    const newest = await page
      .locator(
        '[data-testid="workflow-runs-row-link-0"], [data-testid="workflow-runs-mobile-row-link-0"]',
      )
      .filter({ visible: true })
      .first()
      .getAttribute("href");
    if (
      !newest?.startsWith(`/cockpit/workflows/${FAILED}?`) ||
      !newest.includes(`run=${FAILED_RUN}`)
    )
      throw new Error(`${where}: the newest run's row leads to ${newest}`);
    await assertSingleTriggers(page, where);

    where = `/workflows/<plain> (${localeName})`;
    await stand.visit(page, `workflows/${PLAIN}`);
    await expectWorkflowTitle(page, where);
    await assertSingleTriggers(page, where);
    const change = page.getByTestId("workflow-menu-change");
    await change.waitFor({ state: "visible" });
    if ((await change.innerText()).trim() !== (de ? "Im Chat ändern" : "Change in chat"))
      throw new Error(`${where}: the menu offers "${await change.innerText()}"`);
    const href = await change.getAttribute("href");
    const chat = new URL(href ?? "", "http://x");
    if (chat.pathname !== "/cockpit/chat/new")
      throw new Error(`${where}: the entry leads to ${href}, not a new conversation`);
    if (chat.searchParams.get("workflow_id") !== PLAIN)
      throw new Error(`${where}: the conversation is not about this workflow`);
    const prompt = chat.searchParams.get("prompt");
    const intent = de
      ? `Ändere den Workflow „${NAMES[PLAIN]}“: `
      : `Change the workflow “${NAMES[PLAIN]}”: `;
    if (prompt !== intent)
      throw new Error(`${where}: the conversation opens with "${prompt}", not "${intent}"`);
    await page.keyboard.press("Escape");

    where = `/connectors/<expired> (${localeName})`;
    await stand.visit(page, `connectors/${EXPIRED_CONNECTOR}`);
    const renew = page.getByTestId("connector-renew-signin");
    await renew.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    if (await page.getByTestId("detail-action").count())
      throw new Error(`${where}: a second trigger for the sign-in stands beside the title`);
    const renewLabel = (await renew.innerText()).trim();
    if (renewLabel !== (de ? "Neu anmelden" : "Sign in again"))
      throw new Error(`${where}: the strip's action reads "${renewLabel}"`);
    if (!(await page.getByTestId("connector-state").getByTestId("connector-renew-signin").count()))
      throw new Error(`${where}: renewing the sign-in is not the strip's action`);
    await assertSingleTriggers(page, where);
    await capture("detail-action-reconnect");

    where = `/connectors/<healthy> (${localeName})`;
    await stand.visit(page, `connectors/${HEALTHY_CONNECTOR}`);
    await page.getByTestId("connector-menu").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    if (await page.getByTestId("detail-action").count())
      throw new Error(`${where}: a healthy connector offers an extra action`);
    const body = await page.locator("body").innerText();
    for (const stale of STALE)
      if (body.includes(stale)) throw new Error(`${where}: the page still offers "${stale}"`);
    await assertSingleTriggers(page, where);
  } finally {
    await page.unroute(isDetailApi, handler);
  }

  for (const resource of ["skills", "knowledge"]) {
    const where = `/${resource}/<record> (${localeName})`;
    await stand.visit(page, `${resource}/${uuid}`);
    await page.getByTestId(`detail-${resource}`).waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    await assertSingleTriggers(page, where);
    await assertRecordHeader(page, where, de);
  }
}
