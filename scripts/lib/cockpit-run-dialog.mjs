import { assertNoVisibleUuids } from "./cockpit-visible-uuids.mjs";

const WORKFLOW_ID = "6c1e7f24-3b9a-4d05-8e61-2f7a9c4d1b83";
const CURRENT_VERSION_ID = "b82d4f19-7c3e-4a60-9d15-e4a6c8f0b217";
const DRAFT_VERSION_ID = "1f5a9e3c-8b2d-4c71-a064-d3b7e9f2c518";
const DEV_MAIL_ID = "d94b2e61-5a8f-4c3d-b7e0-9f1a2c6d8e45";
const REFUSED_RUN_ID = "3e7c1a95-2d4b-4f68-a0c9-8b5e1d7f3a26";

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const RECORD = {
  id: WORKFLOW_ID,
  tenant_id: WORKFLOW_ID,
  name: "Tagesbericht versenden",
  slug: "tagesbericht",
  description: "Schickt den Tagesbericht per Mail.",
  lifecycle: "active",
  current_version: 4,
  current_version_id: CURRENT_VERSION_ID,
  draft_version_id: DRAFT_VERSION_ID,
  health_state: "ok",
  health_reason: null,
  health_changed_at: null,
  steps: [{ id: "send", name: "Bericht senden", kind: "request" }],
  updated_at: "2026-08-10T09:00:00.000Z",
};

const MAIL_REFUSAL = {
  step_id: "send",
  connector_id: DEV_MAIL_ID,
  connector_slug: "mail",
  connector_name: "Mail",
};

const LIVE_RUN_ID = "7a2c9e41-6b3d-4f58-9e07-c1d4a8b6f293";

const PROD_AUTHORITY = {
  id: "5d8e2b17-9c4a-4e63-b1f0-a7c3d9e6f402",
  tenant_id: WORKFLOW_ID,
  workflow_id: WORKFLOW_ID,
  workflow_version_id: CURRENT_VERSION_ID,
  effect_manifest_digest: "a".repeat(64),
  effect_manifest: {
    schema_version: 1,
    workflow_id: WORKFLOW_ID,
    workflow_version_id: CURRENT_VERSION_ID,
    execution_environment: "prod",
    effects: [],
    issues: [],
  },
  execution_environment: "prod",
  target_constraints: { targets: [] },
  valid_from: "2026-08-01T09:00:00.000Z",
  valid_until: null,
  max_runs: null,
  reserved_runs: 0,
  remaining_runs: null,
  open_ended: true,
  created_by: WORKFLOW_ID,
  created_at: "2026-08-01T09:00:00.000Z",
  revoked_at: null,
  revoked_by: null,
  inherited_from: null,
  superseded_by: null,
  active_version: true,
  ready_for_new_run: true,
  state: "approved",
};

const TYPED_SCHEMA = {
  type: "object",
  required: ["recipient_email", "limit"],
  properties: {
    recipient_email: { type: "string", format: "email", description: "Wer den Bericht bekommt" },
    limit: { type: "integer", default: 5 },
    mode: { type: "string", enum: ["draft", "live"] },
    options: { type: "object", properties: { deep: { type: "boolean" } } },
    dry: { type: "boolean" },
  },
};

function runDialogApi(state) {
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === `/v1/workflows/${WORKFLOW_ID}`) return json(route, RECORD);
    if (path === `/v1/workflows/${WORKFLOW_ID}/input-schema`)
      return json(route, {
        source: "declared",
        schema: state.variant === "typed" ? TYPED_SCHEMA : null,
      });
    if (path === `/v1/workflows/${WORKFLOW_ID}/draft`)
      return json(route, {
        workflow_id: WORKFLOW_ID,
        version_id: DRAFT_VERSION_ID,
        version: 5,
        current_version_id: CURRENT_VERSION_ID,
        definition: { name: RECORD.name, steps: RECORD.steps },
      });
    if (path === `/v1/workflows/${WORKFLOW_ID}/execution-authorities`)
      return json(route, {
        items: state.variant === "live" ? [PROD_AUTHORITY] : [],
        next_cursor: null,
      });
    if (path === "/v1/executions" && request.method() === "POST") {
      state.runs.push({
        environment: request.headers()["x-subkit-environment"],
        body: request.postDataJSON(),
      });
      if (state.variant === "live")
        return json(route, { execution_id: LIVE_RUN_ID, status: "running" }, 202);
      if (state.variant === "crashed")
        return json(route, { code: "internal_error", message: "internal error" }, 500);
      if (state.variant === "invalid")
        return json(
          route,
          {
            code: "workflow_version_invalid",
            message:
              'this workflow version is stored in an earlier definition format and cannot run — step "send", steps.0.language: invalid. Save the workflow again in the current format.',
            details: {
              issues: [{ path: "steps.0.language", step_id: "send", message: "invalid" }],
            },
          },
          409,
        );
      return json(
        route,
        {
          code: "prepared_credential_unavailable",
          message: 'Connector "mail" in dev must be reconnected before this workflow can run.',
          details: {
            ...MAIL_REFUSAL,
            environment: "dev",
            reason: "needs_reauth",
            execution_id: REFUSED_RUN_ID,
          },
        },
        409,
      );
    }
    return route.fallback();
  };
}

const isRunDialogApi = (url) => {
  const { pathname } = new URL(url);
  return pathname.startsWith(`/v1/workflows/${WORKFLOW_ID}`) || pathname === "/v1/executions";
};

async function text(page, testId) {
  const element = page.getByTestId(testId);
  if (!(await element.count())) return null;
  return (await element.first().innerText()).trim();
}

async function assertNoEngineWords(page, where) {
  const body = await page.locator("body").innerText();
  for (const raw of ["internal error", "internal_error", "must be reconnected before"])
    if (body.includes(raw)) throw new Error(`${where}: the dialog prints the engine's "${raw}"`);
}

async function openDialog(page, stand) {
  await stand.visit(page, `workflows/${WORKFLOW_ID}`);
  await page.getByTestId("workflow-run-open").click();
  await page.getByTestId("workflow-run-dialog").waitFor({ state: "visible", timeout: 10_000 });
}

export async function verifyRunDialog(page, stand, localeName, capture) {
  const de = localeName === "de";
  const state = { variant: "refused", runs: [] };
  const handler = runDialogApi(state);
  await page.route(isRunDialogApi, handler);
  const where = `/workflows/<run dialog> (${localeName})`;
  try {
    await openDialog(page, stand);
    const title = (await text(page, "workflow-run-dialog-title")) ?? "";
    const asked = de
      ? "Tagesbericht versenden jetzt ausführen?"
      : "Run Tagesbericht versenden now?";
    if (title !== asked) throw new Error(`${where}: the dialog asks "${title}", not "${asked}"`);
    const preview = (await text(page, "workflow-run-dialog-description")) ?? "";
    if (!preview.includes(de ? "Probelauf ohne Wirkung" : "preview without effects"))
      throw new Error(`${where}: without an approval the dialog says "${preview}"`);
    for (const retired of ["workflow-run-environment", "workflow-run-confirm"])
      if (await page.getByTestId(retired).count())
        throw new Error(`${where}: the dialog still shows ${retired}`);
    const submit = (await text(page, "workflow-run-submit")) ?? "";
    if (submit !== (de ? "Ausführen" : "Run"))
      throw new Error(`${where}: the dialog's verb is "${submit}"`);
    await assertNoVisibleUuids(page.getByTestId("workflow-run-dialog"), where);
    await capture("run-dialog");
    await page.getByTestId("workflow-run-submit").click();
    const error = page.getByTestId("workflow-run-error");
    await error.waitFor({ state: "visible", timeout: 10_000 });
    if (state.runs.at(-1)?.environment !== undefined)
      throw new Error(
        `${where} · refused: the cockpit chose ${state.runs.at(-1)?.environment} without an approval`,
      );
    const expected = de
      ? "Entwicklung: Mail muss neu verbunden werden"
      : "Development: Mail must be reconnected";
    const said = (await error.innerText()).trim();
    if (!said.includes(expected))
      throw new Error(`${where} · refused: the dialog says "${said}", not "${expected}"`);
    const remedy = await page.getByTestId("workflow-run-error-remedy").getAttribute("href");
    if (remedy !== `/cockpit/connectors/${DEV_MAIL_ID}?tab=connection`)
      throw new Error(`${where} · refused: the refusal leads to ${remedy}, not Mail's sign-in`);
    if (!(await page.getByTestId("workflow-run-submit").isDisabled()))
      throw new Error(`${where} · refused: the refused run can be started again`);
    await page.getByTestId("workflow-run-repeats").waitFor({ state: "visible" });
    await assertNoEngineWords(page, `${where} · refused`);
    await capture("run-dialog-refused");

    state.variant = "live";
    await openDialog(page, stand);
    const live = page.getByTestId("workflow-run-dialog-description");
    await live
      .filter({ hasText: de ? "freigegebenen Version" : "approved version" })
      .waitFor({ timeout: 10_000 });
    await page.getByTestId("workflow-run-submit").click();
    await page.getByTestId("workflow-run-dialog").waitFor({ state: "detached", timeout: 10_000 });
    if (state.runs.at(-1)?.environment !== "prod")
      throw new Error(
        `${where} · live: the approved run went to ${state.runs.at(-1)?.environment}, not production`,
      );
    await page.waitForURL((url) => url.searchParams.get("run") === LIVE_RUN_ID, {
      timeout: 10_000,
    });
    await page
      .getByTestId("run-detail")
      .waitFor({ state: "visible", timeout: 5_000 })
      .catch((error) => {
        throw new Error(`${where} · live: the started run's sheet did not open`, { cause: error });
      });
    await page.keyboard.press("Escape");
    await page.getByTestId("run-detail").waitFor({ state: "hidden" });

    state.variant = "crashed";
    await openDialog(page, stand);
    await page.getByTestId("workflow-run-submit").click();
    await page.getByTestId("workflow-run-error").waitFor({ state: "visible", timeout: 10_000 });
    const crashed = (await text(page, "workflow-run-error")) ?? "";
    const failed = de ? "Der Lauf konnte nicht gestartet werden." : "The run could not be started.";
    if (!crashed.includes(failed))
      throw new Error(`${where} · crashed: the dialog says "${crashed}"`);
    if (await page.getByTestId("workflow-run-submit").isDisabled())
      throw new Error(`${where} · crashed: a fault disables another attempt`);
    await assertNoEngineWords(page, `${where} · crashed`);

    state.variant = "invalid";
    await openDialog(page, stand);
    await page.getByTestId("workflow-run-submit").waitFor({ state: "visible" });
    await page.getByTestId("workflow-run-submit").click();
    await page.getByTestId("workflow-run-error").waitFor({ state: "visible", timeout: 10_000 });
    const invalidSaid = (await text(page, "workflow-run-error")) ?? "";
    if (
      !invalidSaid.includes(de ? "älteren Format" : "earlier format") ||
      !invalidSaid.includes("send")
    )
      throw new Error(`${where} · invalid: the dialog says "${invalidSaid}"`);
    if (invalidSaid.includes(failed))
      throw new Error(`${where} · invalid: a refusal with a reason reads as a fault`);
    for (const raw of ["definition format", "steps.0.language"])
      if (invalidSaid.includes(raw))
        throw new Error(`${where} · invalid: the dialog prints the engine's "${raw}"`);
    if (!(await page.getByTestId("workflow-run-submit").isDisabled()))
      throw new Error(`${where} · invalid: a version the engine refuses can be started again`);
    await page.getByTestId("workflow-run-repeats").waitFor({ state: "visible" });
    await capture("run-dialog-invalid");

    state.variant = "typed";
    await openDialog(page, stand);
    await page.getByTestId("workflow-run-inputs").waitFor({ state: "visible", timeout: 10_000 });
    const typed = `${where} · typed`;
    const limit = page.getByTestId("workflow-run-input-1");
    if ((await limit.getAttribute("type")) !== "number")
      throw new Error(`${typed}: a whole number is filled in through a text field`);
    if ((await limit.inputValue()) !== "5")
      throw new Error(`${typed}: the default is not shown: "${await limit.inputValue()}"`);
    const options = page.getByTestId("workflow-run-input-3");
    if ((await options.evaluate((node) => node.tagName)) !== "TEXTAREA")
      throw new Error(`${typed}: an object is filled in through a one-line field`);
    if (!(await text(page, "workflow-run-missing"))?.includes("recipient_email"))
      throw new Error(`${typed}: the missing required field is not named`);
    await page.getByTestId("workflow-run-input-0").fill("ops@example.org");
    await options.fill("{broken");
    if (!(await text(page, "workflow-run-invalid"))?.includes("options"))
      throw new Error(`${typed}: a value that is not JSON is not named`);
    if (!(await page.getByTestId("workflow-run-submit").isDisabled()))
      throw new Error(`${typed}: a run can start with an input of the wrong type`);
    await capture("run-dialog-typed");
    await options.fill('{"deep":true}');
    await page.getByTestId("workflow-run-input-2").click();
    await page.getByTestId("workflow-run-input-2-option-1").click();
    await page.getByTestId("workflow-run-input-4").click();
    await page.getByTestId("workflow-run-input-4-option-0").click();
    const before = state.runs.length;
    await page.getByTestId("workflow-run-submit").click();
    await page.getByTestId("workflow-run-error").waitFor({ state: "visible", timeout: 10_000 });
    const sent = state.runs.at(-1)?.body?.input;
    const wanted = {
      recipient_email: "ops@example.org",
      limit: 5,
      mode: "live",
      options: { deep: true },
      dry: true,
    };
    if (state.runs.length !== before + 1 || JSON.stringify(sent) !== JSON.stringify(wanted))
      throw new Error(`${typed}: the run was sent ${JSON.stringify(sent)}`);
  } finally {
    await page.unroute(isRunDialogApi, handler);
  }
}
