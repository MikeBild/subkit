import { assertSingleTriggers, TRANSCRIPT } from "./cockpit-single-trigger.mjs";
import { assertNoVisibleUuids } from "./cockpit-visible-uuids.mjs";
import { api, isPageApi, open, openTab, WORKFLOW } from "./cockpit-workflow-page.mjs";

const WORKFLOW_VERSION = "7e9a1c3b-5d2f-4b46-9e80-1a3c5e7f9b52";

const WORDS = {
  de: {
    freshTitle: "Example API Demo Fetch v9 freigeben",
    sameBoundary: "Widerrufbar unter Freigaben. Wächst die Grenze, fragt SubKit neu.",
    already: "Bereits freigegeben bis",
    oneLeft: "1 Lauf übrig",
    untilRevoked: "bis auf Widerruf",
    sevenDays: "7 Tage",
    thirtyDays: "30 Tage",
    untilRevokedOption: "Bis auf Widerruf",
    soFar: "41 Läufe bisher",
    extend: "Verlängern / Grenzen ändern",
    production: "Produktion",
    development: "Entwicklung",
    trial: "Beim Öffnen startet ein Probelauf ohne Wirkung.",
    again: "Vorbereitung erneut ausführen",
    repair: "Automatisch reparieren",
    approve: "Jetzt freigeben",
    cause: "Ursache ansehen",
    reviewProd: "Produktion prüfen",
    reviewDev: "Entwicklung prüfen",
    open: "Öffne die Prüfung",
    hookCalls: "eingehende Webhook-Aufrufe",
    scheduled: "geplante Läufe",
    automatic: "automatische Läufe",
    trialTitle: "Probelauf ohne Wirkung",
    refusedTitle: "Lauf abgelehnt",
    notApplied: "Gespeicherte Änderung noch nicht übernommen",
    ran: "ausgeführt",
    onRequest: "Auf Abruf",
    resume: "Fortsetzen",
  },
  en: {
    freshTitle: "Approve Example API Demo Fetch v9",
    sameBoundary: "Revocable under Approvals. SubKit asks again when the approved boundary grows.",
    already: "Already approved until",
    oneLeft: "1 run left",
    untilRevoked: "until revoked",
    sevenDays: "7 days",
    thirtyDays: "30 days",
    untilRevokedOption: "Until revoked",
    soFar: "41 runs so far",
    extend: "Extend / change limits",
    production: "Production",
    development: "Development",
    trial: "Opening the review starts a trial run without effects.",
    again: "Run the preparation again",
    repair: "Repair automatically",
    approve: "Approve now",
    cause: "See the cause",
    reviewProd: "Review production",
    reviewDev: "Review development",
    open: "Open the review",
    hookCalls: "incoming webhook calls",
    scheduled: "scheduled runs",
    automatic: "automatic runs",
    trialTitle: "Trial run without effects",
    refusedTitle: "Run refused",
    notApplied: "Saved change not applied yet",
    ran: "Ran ",
    onRequest: "On request",
    resume: "Resume",
  },
};

function freshState() {
  return {
    scenario: "approved",
    address: true,
    expiring: false,
    grants: [],
    resumed: [],
    diagnosed: [],
    prepares: [],
    repairs: [],
    previews: 0,
  };
}

const text = async (locator) =>
  (await locator.count()) ? (await locator.first().innerText()).trim() : "";

async function closeDialog(page) {
  await page.getByTestId("authority-grant-cancel").click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}

export async function verifyGrantDialog(page, stand, localeName, capture) {
  const words = WORDS[localeName];
  const state = freshState();
  const handler = api(state);
  const authorityList = (url) =>
    new URL(url).pathname === `/v1/workflows/${WORKFLOW}/execution-authorities`;
  const versionHistory = (url) => new URL(url).pathname === `/v1/workflows/${WORKFLOW}/history`;
  const freshAuthorityHandler = async (route) => {
    if (state.scenario === "grant" && route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], next_cursor: null }),
      });
      return;
    }
    await route.fallback();
  };
  const versionHistoryHandler = (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [{ id: WORKFLOW_VERSION, version: 9 }], total: 1 }),
    });
  };
  await page.route(isPageApi, handler);
  await page.route(authorityList, freshAuthorityHandler);
  await page.route(versionHistory, versionHistoryHandler);
  const at = (name) => `/workflows/<approval dialog: ${name}> (${localeName})`;
  try {
    let where = at("fresh grant");
    const authoritiesResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/v1/workflows/${WORKFLOW}/execution-authorities` &&
        response.request().method() === "GET",
    );
    await open(page, stand, state, "grant");
    const authorities = await (await authoritiesResponse).json();
    if (authorities.items.length !== 0)
      throw new Error(
        `${where}: the fresh fixture contains ${authorities.items.length} authorities`,
      );
    await page.getByTestId("workflow-automation-action").click();
    await page.getByTestId("authority-grant-review").waitFor({ timeout: 15_000 });
    const freshTitle = await text(page.getByTestId("authority-dialog-title"));
    if (freshTitle !== words.freshTitle)
      throw new Error(`${where}: the title reads "${freshTitle}"`);
    const sameBoundary = await text(page.getByTestId("authority-consequence"));
    if (sameBoundary !== words.sameBoundary)
      throw new Error(`${where}: the same-boundary consequence reads "${sameBoundary}"`);
    await assertSingleTriggers(page, where, DIALOG);
    await capture("fresh-grant");
    await closeDialog(page);
    if (state.grants.length) throw new Error(`${where}: looking at the dialog granted something`);

    where = at("already approved");
    state.expiring = true;
    await open(page, stand, state, "approved");
    await page.getByTestId("workflow-automation-action").click();
    await page.getByTestId("authority-grant-review").waitFor({ timeout: 15_000 });
    const title = await text(page.getByTestId("authority-dialog-title"));
    if (!title.startsWith(words.already) || !title.endsWith(words.oneLeft))
      throw new Error(`${where}: the dialog is headed "${title}"`);
    const confirm = await text(page.getByTestId("authority-grant-confirm"));
    if (confirm !== words.extend)
      throw new Error(`${where}: a second approval is offered as "${confirm}"`);
    if (
      (await page.getByTestId("authority-limit-until-revoked").getAttribute("data-state")) !== "on"
    )
      throw new Error(`${where}: the dialog does not start at "until revoked"`);
    const durationChoices = [
      ["authority-limit-seven-days", words.sevenDays],
      ["authority-limit-thirty-days", words.thirtyDays],
      ["authority-limit-until-revoked", words.untilRevokedOption],
    ];
    const durationControl = page.getByTestId("authority-limit");
    for (const [testId, label] of durationChoices) {
      const option = page.getByTestId(testId);
      if ((await text(option)) !== label)
        throw new Error(`${where}: ${testId} visibly reads "${await text(option)}"`);
      await durationControl.getByRole("radio", { name: label, exact: true }).waitFor({
        state: "visible",
      });
    }
    for (const field of ["authority-runs", "authority-hours", "authority-suggestion"])
      if (await page.getByTestId(field).count())
        throw new Error(`${where}: "until revoked" shows ${field}`);
    await assertSingleTriggers(page, `${where}, until revoked`, DIALOG);
    await capture("until-revoked");
    for (const duration of ["seven-days", "thirty-days"]) {
      const option = page.getByTestId(`authority-limit-${duration}`);
      await option.click();
      if ((await option.getAttribute("data-state")) !== "on")
        throw new Error(`${where}: ${duration} cannot be selected`);
      for (const field of ["authority-runs", "authority-hours", "authority-suggestion"])
        if (await page.getByTestId(field).count())
          throw new Error(`${where}: duration selection exposes obsolete ${field}`);
    }
    for (const scope of ["authority-scope-environment", "authority-scope-version"])
      if (await page.getByTestId(scope).count())
        throw new Error(`${where}: the ordinary scope is warned about (${scope})`);
    await assertNoVisibleUuids(page.getByRole("dialog"), where);
    const said = await page
      .getByTestId("authority-grant-review")
      .getByText(words.production, { exact: true })
      .count();
    if (said) throw new Error(`${where}: the review repeats the environment the select shows`);
    await assertSingleTriggers(page, where, DIALOG);
    await capture("already-approved");

    where = at("scope");
    await page.getByTestId("authority-environment").click();
    await page.getByTestId("authority-environment-dev").click();
    const scope = page.getByTestId("authority-scope-environment");
    await scope.waitFor({ timeout: 15_000 });
    const scopeText = await scope.innerText();
    if (!scopeText.includes(words.development) || !scopeText.includes(words.production))
      throw new Error(`${where}: the scope warning reads "${scopeText}"`);
    await page.getByTestId("authority-grant-review").waitFor({ timeout: 15_000 });
    if ((await page.getByTestId("authority-limit-thirty-days").getAttribute("data-state")) !== "on")
      throw new Error(`${where}: changing environment lost the selected approval duration`);
    for (const field of ["authority-runs", "authority-hours", "authority-suggestion"])
      if (await page.getByTestId(field).count())
        throw new Error(`${where}: development exposes obsolete ${field}`);
    await assertSingleTriggers(page, where, DIALOG);
    await capture("scope-warning");
    await closeDialog(page);
    if (state.grants.length) throw new Error(`${where}: looking at the dialog granted something`);
    state.expiring = false;

    where = at("until revoked");
    state.untilRevoked = true;
    const standing = await open(page, stand, state, "approved");
    if ((await standing.getAttribute("data-state")) !== "approved")
      throw new Error(`${where}: the panel is in "${await standing.getAttribute("data-state")}"`);
    if (await page.getByTestId("workflow-automation-action").count())
      throw new Error(`${where}: an approval until revoked is offered for extension`);
    await openTab(page, "approvals");
    const approvals = await text(page.getByTestId("workflow-approvals"));
    if (!approvals.includes(words.untilRevoked))
      throw new Error(`${where}: "Freigaben" does not say "${words.untilRevoked}": "${approvals}"`);
    const revoke = page.getByTestId("authority-current-revoke").filter({ visible: true });
    await revoke.first().waitFor();
    if ((await revoke.count()) !== 1)
      throw new Error(`${where}: the approval cannot be revoked exactly once`);
    await assertSingleTriggers(page, where);
    await capture("approved-until-revoked");
    state.untilRevoked = false;

    where = at("mixed environments");
    state.devSchedule = true;
    state.devPending = true;
    const mixed = await open(page, stand, state, "approved");
    if ((await mixed.getAttribute("data-state")) !== "grant")
      throw new Error(`${where}: the panel is in "${await mixed.getAttribute("data-state")}"`);
    const mixedLine = await text(page.getByTestId("workflow-automation-headline"));
    if (!mixedLine.includes(words.development) || mixedLine.includes(words.production))
      throw new Error(`${where}: the headline names the wrong environment: "${mixedLine}"`);
    await page.getByTestId("workflow-automation-action").click();
    await page.getByTestId("authority-grant-review").waitFor({ timeout: 15_000 });
    if (!(await text(page.getByTestId("authority-environment"))).includes(words.development))
      throw new Error(`${where}: the approval opens in the environment that is already approved`);
    if (state.diagnosed.at(-1) !== "dev")
      throw new Error(`${where}: the diagnosis was asked for ${state.diagnosed.at(-1)}`);
    await assertSingleTriggers(page, where, DIALOG);
    await capture("mixed-environments");
    await closeDialog(page);
    await openTab(page, "approvals");
    await page.getByTestId("authority-valid-0").filter({ visible: true }).first().waitFor();
    if (!(await page.getByTestId("authority-valid-0-revoke").count()))
      throw new Error(`${where}: production's approval cannot be revoked from here`);
    state.devSchedule = false;
    state.devPending = false;

    where = at("not approvable");
    state.trialNeeded = true;
    state.unsupported = true;
    await open(page, stand, state, "apply");
    await page.getByTestId("workflow-status-strip-help").hover();
    const tip = page.getByRole("tooltip");
    await tip.first().waitFor();
    const notice = await text(tip);
    if (!notice.includes(words.trial)) throw new Error(`${where}: the opener says "${notice}"`);
    await page.mouse.move(0, 0);
    if (state.prepares.length)
      throw new Error(`${where}: opening the page started ${state.prepares.length} trial runs`);
    await capture("opening-notice");
    await page.getByTestId("workflow-automation-action").click();
    const again = page.getByTestId("authority-remedy-prepare");
    await again.waitFor({ timeout: 15_000 });
    if (state.prepares.length !== 1)
      throw new Error(`${where}: opening started ${state.prepares.length} trial runs, not one`);
    if ((await text(again)) !== words.again)
      throw new Error(`${where}: the remedy reads "${await text(again)}"`);
    if ((await again.getAttribute("data-variant")) !== "default")
      throw new Error(`${where}: the remedy is not the dialog's filled action`);
    if ((await page.getByTestId("authority-adjust").getAttribute("data-variant")) !== "outline")
      throw new Error(`${where}: two filled actions stand in the dialog`);
    if (await page.getByTestId("authority-grant-confirm").count())
      throw new Error(`${where}: a version that cannot be approved offers approving`);
    if (await page.getByTestId("authority-scope-version").count())
      throw new Error(`${where}: a version that cannot be approved is announced as being approved`);
    if (await page.getByTestId("authority-effect-details").count())
      throw new Error(`${where}: the operations are offered for opening, and there are none`);
    const versionLabel = await text(page.getByTestId("authority-version-label"));
    if (!versionLabel.includes("v10"))
      throw new Error(`${where}: the reviewed version reads "${versionLabel}"`);
    await assertNoVisibleUuids(page.getByRole("dialog"), where);
    await assertSingleTriggers(page, where, DIALOG);
    await capture("not-approvable");
    await again.click();
    for (let attempt = 0; state.prepares.length < 2 && attempt < 100; attempt += 1)
      await page.waitForTimeout(100);
    if (state.prepares.length !== 2)
      throw new Error(`${where}: running the preparation again sent no request`);
    await again.waitFor({ timeout: 15_000 });
    await closeDialog(page);
    if (state.grants.length) throw new Error(`${where}: the refused review granted something`);
  } finally {
    await page.unroute(versionHistory, versionHistoryHandler);
    await page.unroute(authorityList, freshAuthorityHandler);
    await page.unroute(isPageApi, handler);
    await stand.visit(page, "workflows");
  }
}

function reviewPart(callId) {
  return {
    type: "dynamic-tool",
    toolName: "review_workflow_automation",
    toolCallId: callId,
    state: "output-available",
    input: { workflow_id: WORKFLOW },
    output: {
      ok: true,
      data: {
        kind: "workflow_automation_review",
        presentation: "automation_readiness_card",
        workflow_id: WORKFLOW,
        schedules: [{ workflow_id: WORKFLOW, environment: "prod", state: "approval_required" }],
        inbound_hooks: [],
        saved_change: null,
      },
    },
  };
}

const DIALOG = { root: '[role="dialog"]', approvalOpeners: 0 };

export async function verifyChatReviewCard(page, stand, conversation, localeName, capture) {
  const words = WORDS[localeName];
  const state = { ...freshState(), scenario: "grant" };
  const handler = api(state);
  const original = await page.evaluate(
    async (id) => (await fetch(`/v1/conversations/${id}`)).json(),
    conversation.id,
  );
  const execution = "6b8d0f2a-4c1e-4a37-9b5d-1e3a5c7e9f48";
  const detail = (route) =>
    route.request().method() !== "GET"
      ? route.fallback()
      : route.fulfill({
          json: {
            ...original,
            conversation: { ...original.conversation, target_workflow_id: WORKFLOW },
            tool_calls: [],
            messages: [
              {
                id: "earlier-request",
                role: "user",
                created_at: conversation.updated_at,
                parts: [{ type: "text", text: "Darf der Ablauf automatisch laufen?" }],
              },
              {
                id: "earlier-work",
                role: "assistant",
                created_at: conversation.updated_at,
                parts: [reviewPart("earlier-review")],
              },
              {
                id: "request",
                role: "user",
                created_at: conversation.updated_at,
                parts: [{ type: "text", text: "Bitte nichts ausführen, nur prüfen." }],
              },
              {
                id: "work",
                role: "assistant",
                created_at: conversation.updated_at,
                parts: [
                  {
                    type: "dynamic-tool",
                    toolName: "run_workflow",
                    toolCallId: "prepare",
                    state: "output-error",
                    input: { workflow: "example-api-demo-fetch", execute_writes: false },
                    output: {
                      ok: false,
                      data: {
                        execution_id: execution,
                        workflow_id: WORKFLOW,
                        status: "failed",
                        hold_writes: true,
                        writes_held: true,
                        held_step_ids: ["send_email"],
                        failure_step_key: "send_email",
                      },
                    },
                  },
                  {
                    type: "dynamic-tool",
                    toolName: "run_workflow",
                    toolCallId: "refused",
                    state: "output-error",
                    input: { workflow: "example-api-demo-fetch" },
                    output: {
                      ok: false,
                      data: { error_code: "workflow_activation_required", status: "failed" },
                    },
                  },
                  reviewPart("review"),
                ],
              },
            ],
            resume_summary: { ...original.resume_summary, pending_approval: null },
          },
        });
  const detailPattern = `**/v1/conversations/${conversation.id}`;
  await page.route(isPageApi, handler);
  await page.route(detailPattern, detail);
  const at = (name) => `/chat/<review card: ${name}> (${localeName})`;
  const refused = [];
  const noteRefused = (response) => {
    if (response.status() >= 400 && response.url().includes(WORKFLOW))
      refused.push(`${response.status()} ${new URL(response.url()).pathname}`);
  };
  page.on("response", noteRefused);
  const card = page.getByTestId("chat-transcript").getByTestId("chat-automation-tool");
  const buttons = card.locator("button");
  const openCard = async (scenario) => {
    state.scenario = scenario;
    await stand.visit(page, `chat/${conversation.id}`);
    try {
      await card.getByTestId("chat-automation-tool-body").waitFor({ timeout: 15_000 });
    } catch (cause) {
      const shown = (await card.count()) ? await card.first().innerText() : "(no card)";
      throw new Error(
        `The review card did not say its state in "${scenario}": ${shown} — refused reads: ${JSON.stringify(refused)}`,
        { cause },
      );
    }
    await page.waitForLoadState("networkidle");
  };
  try {
    let where = at("one environment");
    await openCard("grant");
    if ((await buttons.count()) !== 1)
      throw new Error(`${where}: the card offers ${await buttons.count()} buttons`);
    const only = card.getByTestId("chat-automation-tool-review");
    if ((await text(only)) !== words.approve)
      throw new Error(`${where}: the button reads "${await text(only)}"`);
    const hint = await card.innerText();
    if (!hint.includes(words.open) || !hint.includes(words.automatic))
      throw new Error(`${where}: the hint reads "${hint}"`);
    if (/\bunten\b|\bbelow\b/.test(hint))
      throw new Error(`${where}: the hint points below the card: "${hint}"`);
    if ((await card.count()) !== 1)
      throw new Error(`${where}: ${await card.count()} live review cards for one workflow`);
    await assertSingleTriggers(page, where, { ...TRANSCRIPT, approvalOpeners: 1 });

    const toggles = page.locator('[data-testid^="chat-message-3-tool-"][data-testid$="-toggle"]');
    const titles = await toggles.allInnerTexts();
    if (titles.length !== 2) throw new Error(`${where}: ${titles.length} tool cards, not two`);
    if (!titles[0].includes(words.trialTitle) || titles[0].includes(words.ran))
      throw new Error(`${where}: a preparation is titled "${titles[0]}"`);
    if (!titles[1].includes(words.refusedTitle) || !titles[1].includes(words.notApplied))
      throw new Error(`${where}: a refused run is titled "${titles[1]}"`);
    await assertNoVisibleUuids(page.getByTestId("chat-transcript"), where);
    await capture("one");

    where = at("hook only");
    state.hookOnly = true;
    await openCard("grant");
    if ((await buttons.count()) !== 1 || !(await only.count()))
      throw new Error(`${where}: a hook-started workflow offers ${await buttons.count()} buttons`);
    const hookHint = await card.innerText();
    if (!hookHint.includes(words.hookCalls) || hookHint.includes(words.scheduled))
      throw new Error(`${where}: the hint reads "${hookHint}"`);
    await only.click();
    await page.getByTestId("authority-grant-review").waitFor({ timeout: 15_000 });
    if (!(await text(page.getByTestId("authority-environment"))).includes(words.production))
      throw new Error(`${where}: a webhook's approval does not open in production`);
    await closeDialog(page);
    state.hookOnly = false;

    where = at("two environments");
    state.scheduleOnly = true;
    state.devSchedule = true;
    await openCard("grant");
    const labels = (await buttons.allInnerTexts()).map((label) => label.trim());
    if (labels.join("|") !== [words.reviewProd, words.reviewDev].join("|"))
      throw new Error(`${where}: the buttons read ${JSON.stringify(labels)}`);
    const prod = card.getByTestId("chat-automation-tool-review-prod");
    const dev = card.getByTestId("chat-automation-tool-review-dev");
    if ((await prod.getAttribute("data-variant")) !== "default")
      throw new Error(`${where}: production is not the filled action`);
    if ((await dev.getAttribute("data-variant")) !== "outline")
      throw new Error(`${where}: two filled actions stand on one card`);
    if (await only.count()) throw new Error(`${where}: an unnamed third button stands beside them`);
    if (!(await card.innerText()).includes(words.scheduled))
      throw new Error(`${where}: schedules are not called scheduled runs`);
    await assertSingleTriggers(page, where, { ...TRANSCRIPT, approvalOpeners: 2 });
    await capture("two");
    await dev.click();
    await page.getByTestId("authority-grant-review").waitFor({ timeout: 15_000 });
    if (!(await text(page.getByTestId("authority-environment"))).includes(words.development))
      throw new Error(`${where}: the development button opened another environment`);
    await closeDialog(page);
    state.scheduleOnly = false;
    state.devSchedule = false;

    where = at("repair");
    await openCard("repair");
    if ((await buttons.count()) !== 1 || (await text(only)) !== words.cause)
      throw new Error(`${where}: the card offers ${JSON.stringify(await buttons.allInnerTexts())}`);
    await only.click();
    const remedy = page.getByTestId("authority-remedy");
    await remedy.waitFor({ timeout: 15_000 });
    if ((await text(remedy)) !== words.repair)
      throw new Error(`${where}: the remedy reads "${await text(remedy)}"`);
    if ((await remedy.getAttribute("data-variant")) !== "default")
      throw new Error(`${where}: the repair is not the dialog's filled action`);
    if ((await page.getByTestId("authority-adjust").getAttribute("data-variant")) !== "outline")
      throw new Error(`${where}: two filled actions stand in the dialog`);
    await assertSingleTriggers(page, where, DIALOG);
    await capture("repair");
    await closeDialog(page);
    if (state.repairs.length || state.grants.length)
      throw new Error(`${where}: looking at the review changed something`);

    where = at("approved");
    await openCard("approved");
    if (await buttons.count())
      throw new Error(
        `${where}: an approved workflow still offers ${await buttons.count()} buttons`,
      );

    where = at("on request");
    await openCard("manual");
    const calm = card.getByTestId("chat-automation-tool-body");
    if ((await calm.getAttribute("data-state")) !== "manual")
      throw new Error(`${where}: the card is in "${await calm.getAttribute("data-state")}"`);
    if (await buttons.count())
      throw new Error(`${where}: a workflow nothing starts is offered a button`);
    if (!(await card.innerText()).includes(words.onRequest))
      throw new Error(`${where}: the card reads "${await card.innerText()}"`);
    await assertSingleTriggers(page, where, { ...TRANSCRIPT, approvalOpeners: 0 });
    await capture("on-request");

    where = at("paused");
    await openCard("paused");
    if ((await buttons.count()) !== 1 || (await text(buttons)) !== words.resume)
      throw new Error(`${where}: the card offers ${JSON.stringify(await buttons.allInnerTexts())}`);
    if (await only.count()) throw new Error(`${where}: a paused workflow is offered the approval`);
  } finally {
    page.off("response", noteRefused);
    await page.unroute(detailPattern, detail);
    await page.unroute(isPageApi, handler);
    await stand.visit(page, `chat/${conversation.id}`);
  }
}
