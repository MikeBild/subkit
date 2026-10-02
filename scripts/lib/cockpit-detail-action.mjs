// The one action a workflow or connector page offers beside its title — chosen
// by the record's state, never a fixed "Sicher im Chat fortsetzen" that filled
// its own label into the chat as the question.
//
// Fixtures follow the engine's real schemas and each holds exactly one state:
//
// - a workflow whose webhook the authority gate holds  → "Jetzt freigeben":
//   the automation panel's own action, opening the approval where the reader
//   stands. It used to be "Freigabe prüfen", a link that only scrolled to a
//   section whose button had the same name — two signals and no act;
// - a workflow whose development Gmail lost its sign-in → no authority review
//   on page open (the run dialog asks that), so its state decides as usual;
// - a workflow whose newest run failed                  → "Lauf untersuchen";
// - a workflow with nothing wrong                       → "Im Chat ändern", a
//   new conversation about it that opens with a real intent, not a label;
// - a connector whose sign-in expired                   → "Neu verbinden";
// - a healthy connector                                 → nothing extra.

import { assertNoVisibleUuids } from "./cockpit-visible-uuids.mjs";

const HELD = "7a2c9e41-5d3b-4f86-a1e0-c4b8d2f6e913";
const UNAVAILABLE = "e3b5d7f9-1a2c-4e46-8b60-5d7f9a1c3e28";
const FAILED = "4f8a1c3e-6b2d-4a95-9e07-b1d3f5a7c942";
const PLAIN = "c6d8e0f2-3a4b-4c5d-9e6f-7a8b9c0d1e53";
const VERSION = "2b4d6f81-9a3c-4e5d-b7f0-1c3e5a7b9d64";
const GMAIL_DEV = "8e0a2c4f-6b1d-4f37-a95c-3e5a7c9b1d76";
const EXPIRED_CONNECTOR = "5c7e9a1b-3d2f-4b68-8a04-6e8c0a2d4f87";
const HEALTHY_CONNECTOR = "9d1f3b5c-7e4a-4c26-b813-2f4b6d8e0a98";
const FAILED_RUN = "1a3c5e7f-9b2d-4f48-a6c0-8e0a2c4e6b19";

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const NAMES = {
  [HELD]: "watchkit-finding-triage",
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
    slug: expired ? "gmail" : "lager-api",
    display_name: expired ? "Gmail" : "Lager-API",
    description: null,
    driver: "http",
    environment: "dev",
    auth_type: expired ? "oauth2" : "none",
    base_url: expired ? "https://gmail.googleapis.com" : "https://lager.example.org/api",
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
            connector_id: GMAIL_DEV,
            connector_slug: "gmail",
            connector_name: "Gmail",
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
  // Only the newest run decides: an older failure under a newer success is history.
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
                    slug: "watchkit-findings",
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

async function actionOf(page, where) {
  const action = page.getByTestId("detail-action");
  await action.waitFor({ state: "visible", timeout: 10_000 });
  // The state that picks the action is read after the page: wait for it to settle.
  await page.waitForLoadState("networkidle");
  const body = await page.locator("body").innerText();
  for (const stale of ["Sicher im Chat fortsetzen", "Continue safely in chat"])
    if (body.includes(stale)) throw new Error(`${where}: the page still offers "${stale}"`);
  return {
    label: (await action.innerText()).trim(),
    href: await action.getAttribute("href"),
  };
}

function expect(where, actual, label, href) {
  if (actual.label !== label)
    throw new Error(`${where}: the action reads "${actual.label}", not "${label}"`);
  if (actual.href !== href)
    throw new Error(`${where}: the action leads to ${actual.href}, not ${href}`);
}

export async function verifyDetailAction(page, stand, localeName, capture) {
  const de = localeName === "de";
  const state = { previews: 0 };
  const handler = detailApi(state);
  await page.route(isDetailApi, handler);
  try {
    // ── A workflow its webhook is held for ────────────────────────────────────
    let where = `/workflows/<held> (${localeName})`;
    await stand.visit(page, `workflows/${HELD}`);
    const held = await actionOf(page, where);
    if (held.label !== (de ? "Jetzt freigeben" : "Approve now"))
      throw new Error(`${where}: the action reads "${held.label}"`);
    // An act, not an address: a link here could only scroll to the panel that
    // already says the same thing below it.
    if (held.href !== null)
      throw new Error(`${where}: the action is a link to ${held.href}, not the approval itself`);
    const panelAction = (await page.getByTestId("workflow-automation-action").innerText()).trim();
    if (panelAction !== held.label)
      throw new Error(`${where}: the title offers "${held.label}", the panel "${panelAction}"`);
    if (await page.locator('a[href*="#workflow-authorities"]').count())
      throw new Error(`${where}: something still links to the section that no longer exists`);
    if (state.previews !== 0)
      throw new Error(`${where}: opening the page ran ${state.previews} authority reviews`);
    await assertNoVisibleUuids(page.locator("header").first(), where);
    await capture("detail-action-held");
    // The press opens the approval dialog — the same one the panel opens.
    await page.getByTestId("detail-action").click();
    await page.getByTestId("authority-grant-cancel").waitFor({ state: "visible", timeout: 10_000 });
    if (state.previews < 1) throw new Error(`${where}: the action opened no review`);
    await page.getByTestId("authority-grant-cancel").click();
    await page.getByTestId("authority-grant-cancel").waitFor({ state: "hidden" });

    // ── A workflow whose development Gmail must be reconnected ───────────────
    // The page does not run the authority review to choose its action: that
    // review is a full resolution, asked for when the run dialog opens (where
    // development is then offered disabled) and when a reviewer opens the
    // approval. Its newest run succeeded, so the action is the conversation.
    where = `/workflows/<unavailable> (${localeName})`;
    state.previews = 0;
    await stand.visit(page, `workflows/${UNAVAILABLE}`);
    const unavailable = await actionOf(page, where);
    if (unavailable.label !== (de ? "Im Chat ändern" : "Change in chat"))
      throw new Error(`${where}: the action reads "${unavailable.label}"`);
    if (state.previews !== 0)
      throw new Error(`${where}: opening the page ran ${state.previews} authority reviews`);

    // ── A workflow whose newest run failed ────────────────────────────────────
    where = `/workflows/<failed> (${localeName})`;
    await stand.visit(page, `workflows/${FAILED}`);
    expect(
      where,
      await actionOf(page, where),
      de ? "Lauf untersuchen" : "Investigate run",
      `/cockpit/runs/${FAILED_RUN}`,
    );

    // ── A workflow with nothing wrong: a conversation with a real intent ─────
    where = `/workflows/<plain> (${localeName})`;
    await stand.visit(page, `workflows/${PLAIN}`);
    const plain = await actionOf(page, where);
    if (plain.label !== (de ? "Im Chat ändern" : "Change in chat"))
      throw new Error(`${where}: the action reads "${plain.label}"`);
    const chat = new URL(plain.href ?? "", "http://x");
    if (chat.pathname !== "/cockpit/chat/new")
      throw new Error(`${where}: the action leads to ${plain.href}, not a new conversation`);
    if (chat.searchParams.get("workflow_id") !== PLAIN)
      throw new Error(`${where}: the conversation is not about this workflow`);
    const prompt = chat.searchParams.get("prompt");
    const intent = de
      ? `Ändere den Workflow „${NAMES[PLAIN]}“: `
      : `Change the workflow “${NAMES[PLAIN]}”: `;
    if (prompt !== intent)
      throw new Error(`${where}: the conversation opens with "${prompt}", not "${intent}"`);

    // ── A connector whose sign-in expired ─────────────────────────────────────
    where = `/connectors/<expired> (${localeName})`;
    await stand.visit(page, `connectors/${EXPIRED_CONNECTOR}`);
    expect(
      where,
      await actionOf(page, where),
      de ? "Neu verbinden" : "Reconnect",
      `/cockpit/connectors/${EXPIRED_CONNECTOR}#connector-credentials`,
    );
    if (!(await page.locator("#connector-credentials").count()))
      throw new Error(`${where}: the sign-in card has no anchor to land on`);
    await capture("detail-action-reconnect");

    // ── A healthy connector: the test button is its action ───────────────────
    where = `/connectors/<healthy> (${localeName})`;
    await stand.visit(page, `connectors/${HEALTHY_CONNECTOR}`);
    await page.getByTestId("connector-test").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    if (await page.getByTestId("detail-action").count())
      throw new Error(`${where}: a healthy connector offers an extra action`);
    const body = await page.locator("body").innerText();
    for (const stale of ["Sicher im Chat fortsetzen", "Continue safely in chat"])
      if (body.includes(stale)) throw new Error(`${where}: the page still offers "${stale}"`);
  } finally {
    await page.unroute(isDetailApi, handler);
  }
}
