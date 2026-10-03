// The approval dialog says what it is about to do, and the chat's review card
// offers the workflow page's own next step.
//
// Both stand on the workflow page's fixture (`cockpit-workflow-page.mjs`): one
// workflow, started by a daily schedule and a webhook, in one automation state
// per scenario. What they stand on:
//
// - An approval that already covers the reviewed version heads the dialog and
//   turns the action into "extend / change limits" — never a second identical
//   approval offered as if it were the first.
// - The scope is said where it is not the ordinary one: another environment
//   than the one that starts the workflow. (A saved change that can be
//   approved is covered by `cockpit-workflow-authorities.mjs`; one that cannot
//   is not announced as being approved.)
// - Every fact once: the environment in its select, the version where the
//   caller can name it, no disclosure that opens onto nothing — and every
//   action of the dialog once (`cockpit-single-trigger.mjs`).
// - What opening the dialog sets off is said BEFORE the press.
// - A version that cannot be approved offers the act that removes the refusal.
// - The review card has one button; two only when both environments wait, and
//   then each says which one it is.
// - A card for a workflow call says what the call was: a trial, a refusal, a run.

import { assertSingleTriggers, TRANSCRIPT } from "./cockpit-single-trigger.mjs";
import { assertNoVisibleUuids } from "./cockpit-visible-uuids.mjs";
import { api, isPageApi, open, openTab, WORKFLOW } from "./cockpit-workflow-page.mjs";

const WORDS = {
  de: {
    already: "Bereits freigegeben bis",
    oneLeft: "1 Lauf übrig",
    untilRevoked: "bis auf Widerruf",
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
    already: "Already approved until",
    oneLeft: "1 run left",
    untilRevoked: "until revoked",
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
  await page.route(isPageApi, handler);
  const at = (name) => `/workflows/<approval dialog: ${name}> (${localeName})`;
  try {
    // ── Already approved: the dialog says so and offers the extension ────────
    let where = at("already approved");
    state.expiring = true;
    await open(page, stand, state, "approved");
    // Running out is the strip's top state: extending is its one action.
    await page.getByTestId("workflow-automation-action").click();
    await page.getByTestId("authority-grant-review").waitFor({ timeout: 15_000 });
    const title = await text(page.getByTestId("authority-dialog-title"));
    if (!title.startsWith(words.already) || !title.endsWith(words.oneLeft))
      throw new Error(`${where}: the dialog is headed "${title}"`);
    const confirm = await text(page.getByTestId("authority-grant-confirm"));
    if (confirm !== words.extend)
      throw new Error(`${where}: a second approval is offered as "${confirm}"`);
    // An approval stands until it is revoked unless the reader chooses limits:
    // no run or hour field, and no suggestion for numbers nobody is asked for.
    if (
      (await page.getByTestId("authority-limit-until-revoked").getAttribute("data-state")) !== "on"
    )
      throw new Error(`${where}: the dialog does not start at "until revoked"`);
    for (const field of ["authority-runs", "authority-hours", "authority-suggestion"])
      if (await page.getByTestId(field).count())
        throw new Error(`${where}: "until revoked" shows ${field}`);
    await assertSingleTriggers(page, `${where}, until revoked`, DIALOG);
    await capture("until-revoked");
    await page.getByTestId("authority-limit-limited").click();
    await page.getByTestId("authority-runs").waitFor();
    // Thirty days, sized from the schedule and the hook's calls — and said so.
    if (
      (await page.getByTestId("authority-runs").inputValue()) !== "210" ||
      (await page.getByTestId("authority-hours").inputValue()) !== "720"
    )
      throw new Error(`${where}: the suggested limits are not the engine's`);
    const suggestion = await text(page.getByTestId("authority-suggestion"));
    if (!suggestion.includes("42") || !suggestion.includes("14"))
      throw new Error(`${where}: the suggestion is not explained: "${suggestion}"`);
    for (const scope of ["authority-scope-environment", "authority-scope-version"])
      if (await page.getByTestId(scope).count())
        throw new Error(`${where}: the ordinary scope is warned about (${scope})`);
    await assertNoVisibleUuids(page.getByRole("dialog"), where);
    // The environment is said once — in its select, not again as a badge.
    const said = await page
      .getByTestId("authority-grant-review")
      .getByText(words.production, { exact: true })
      .count();
    if (said) throw new Error(`${where}: the review repeats the environment the select shows`);
    await assertSingleTriggers(page, where, DIALOG);
    await capture("already-approved");

    // ── Another environment than the one that starts it: said ────────────────
    where = at("scope");
    await page.getByTestId("authority-environment").click();
    await page.getByTestId("authority-environment-dev").click();
    const scope = page.getByTestId("authority-scope-environment");
    await scope.waitFor({ timeout: 15_000 });
    const scopeText = await scope.innerText();
    if (!scopeText.includes(words.development) || !scopeText.includes(words.production))
      throw new Error(`${where}: the scope warning reads "${scopeText}"`);
    await page.getByTestId("authority-grant-review").waitFor({ timeout: 15_000 });
    // The choice stays while the reader moves between environments.
    await page.getByTestId("authority-runs").waitFor();
    // Nothing runs in development: the one-run default, with no line to explain.
    if ((await page.getByTestId("authority-runs").inputValue()) !== "1")
      throw new Error(`${where}: a development review inherited production's suggestion`);
    if (await page.getByTestId("authority-suggestion").count())
      throw new Error(`${where}: the one-run default is explained`);
    await assertSingleTriggers(page, where, DIALOG);
    await capture("scope-warning");
    await closeDialog(page);
    if (state.grants.length) throw new Error(`${where}: looking at the dialog granted something`);
    state.expiring = false;

    // ── Approved until revoked: no date, no limit, the runs so far ───────────
    where = at("until revoked");
    state.untilRevoked = true;
    const standing = await open(page, stand, state, "approved");
    if ((await standing.getAttribute("data-state")) !== "approved")
      throw new Error(`${where}: the panel is in "${await standing.getAttribute("data-state")}"`);
    const standingLine = await text(page.getByTestId("workflow-automation-headline"));
    if (!standingLine.includes(words.untilRevoked) || !standingLine.includes(words.soFar))
      throw new Error(`${where}: the headline reads "${standingLine}"`);
    // Nothing runs out: the strip offers nothing at all.
    if (await page.getByTestId("workflow-automation-action").count())
      throw new Error(`${where}: an approval until revoked is offered for extension`);
    await openTab(page, "freigaben");
    // Revoking is the one way it ends — offered once, on the approval itself.
    const revoke = page.getByTestId("authority-current-revoke").filter({ visible: true });
    await revoke.first().waitFor();
    if ((await revoke.count()) !== 1)
      throw new Error(`${where}: the approval cannot be revoked exactly once`);
    await assertSingleTriggers(page, where);
    await capture("approved-until-revoked");
    state.untilRevoked = false;

    // ── Production approved, development waiting: the state names development ─
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
    // Production's approval stays in reach while development is pending.
    await openTab(page, "freigaben");
    await page.getByTestId("authority-valid-0").filter({ visible: true }).first().waitFor();
    if (!(await page.getByTestId("authority-valid-0-revoke").count()))
      throw new Error(`${where}: production's approval cannot be revoked from here`);
    state.devSchedule = false;
    state.devPending = false;

    // ── A saved change the gate has not seen: said before the press ──────────
    where = at("not approvable");
    state.trialNeeded = true;
    state.unsupported = true;
    await open(page, stand, state, "apply");
    const notice = await text(page.getByTestId("grant-opening-notice"));
    if (notice !== words.trial) throw new Error(`${where}: the opener says "${notice}"`);
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
    // The remedy is the filled action; the way to an author stands beside it.
    if ((await again.getAttribute("data-variant")) !== "default")
      throw new Error(`${where}: the remedy is not the dialog's filled action`);
    if ((await page.getByTestId("authority-adjust").getAttribute("data-variant")) !== "outline")
      throw new Error(`${where}: two filled actions stand in the dialog`);
    if (await page.getByTestId("authority-grant-confirm").count())
      throw new Error(`${where}: a version that cannot be approved offers approving`);
    // Nothing can be approved: the dialog does not say "you are approving a
    // saved change", and offers no disclosure that would open onto nothing.
    if (await page.getByTestId("authority-scope-version").count())
      throw new Error(`${where}: a version that cannot be approved is announced as being approved`);
    if (await page.getByTestId("authority-effect-details").count())
      throw new Error(`${where}: the operations are offered for opening, and there are none`);
    // The version is named where the caller knows it, never by a placeholder.
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
    await page.unroute(isPageApi, handler);
    // Leave the page as it was found: this stand filled the client's cache.
    await stand.visit(page, "workflows");
  }
}

/** The tool result that makes a review card, as the engine writes it. */
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
        // What the tool saw when it ran. The card reads the state as it is NOW.
        schedules: [{ workflow_id: WORKFLOW, environment: "prod", state: "approval_required" }],
        inbound_hooks: [],
        saved_change: null,
      },
    },
  };
}

/** The approval dialog, checked as a view of its own. */
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
              // An earlier review of the same workflow. It is history: only the
              // newest review is a live card, or the same button stands twice.
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
                  // A preparation: every write held, the mail step refused.
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
                  // A call the engine turned away before anything started.
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
  // The reads this card rests on that did not answer, for the message of a
  // failed wait: a card that cannot say its state names what it could not read.
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
      // Say what stands there instead: a card that is still loading, one that
      // could not read its state, or no card at all.
      const shown = (await card.count()) ? await card.first().innerText() : "(no card)";
      throw new Error(
        `The review card did not say its state in "${scenario}": ${shown} — refused reads: ${JSON.stringify(refused)}`,
        { cause },
      );
    }
    await page.waitForLoadState("networkidle");
  };
  try {
    // ── One environment: one button, named for the page's own step ───────────
    let where = at("one environment");
    await openCard("grant");
    if ((await buttons.count()) !== 1)
      throw new Error(`${where}: the card offers ${await buttons.count()} buttons`);
    const only = card.getByTestId("chat-automation-tool-review");
    if ((await text(only)) !== words.approve)
      throw new Error(`${where}: the button reads "${await text(only)}"`);
    const hint = await card.innerText();
    // A schedule and a webhook start it: neither word alone would be true.
    if (!hint.includes(words.open) || !hint.includes(words.automatic))
      throw new Error(`${where}: the hint reads "${hint}"`);
    if (/\bunten\b|\bbelow\b/.test(hint))
      throw new Error(`${where}: the hint points below the card: "${hint}"`);
    // Two reviews of this workflow stand in the transcript; one card.
    if ((await card.count()) !== 1)
      throw new Error(`${where}: ${await card.count()} live review cards for one workflow`);
    await assertSingleTriggers(page, where, { ...TRANSCRIPT, approvalOpeners: 1 });

    // A workflow call says what it was — never "ran" over a trial or a refusal.
    const toggles = page.locator('[data-testid^="chat-message-3-tool-"][data-testid$="-toggle"]');
    const titles = await toggles.allInnerTexts();
    if (titles.length !== 2) throw new Error(`${where}: ${titles.length} tool cards, not two`);
    if (!titles[0].includes(words.trialTitle) || titles[0].includes(words.ran))
      throw new Error(`${where}: a preparation is titled "${titles[0]}"`);
    if (!titles[1].includes(words.refusedTitle) || !titles[1].includes(words.notApplied))
      throw new Error(`${where}: a refused run is titled "${titles[1]}"`);
    await assertNoVisibleUuids(page.getByTestId("chat-transcript"), where);
    await capture("one");

    // ── Only a webhook: production, and the hint speaks of webhook calls ─────
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

    // ── Two environments: two buttons, each named, production first ──────────
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
    // Two reviews, in two environments: each button opens its own.
    await assertSingleTriggers(page, where, { ...TRANSCRIPT, approvalOpeners: 2 });
    await capture("two");
    await dev.click();
    await page.getByTestId("authority-grant-review").waitFor({ timeout: 15_000 });
    if (!(await text(page.getByTestId("authority-environment"))).includes(words.development))
      throw new Error(`${where}: the development button opened another environment`);
    await closeDialog(page);
    state.scheduleOnly = false;
    state.devSchedule = false;

    // ── Repair: the card opens the review, the review offers the repair ──────
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

    // ── Approved: the card says so and offers nothing to press ───────────────
    where = at("approved");
    await openCard("approved");
    if (await buttons.count())
      throw new Error(
        `${where}: an approved workflow still offers ${await buttons.count()} buttons`,
      );

    // ── On request: the page's calm state — never the approval dialog ────────
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

    // ── Paused: resuming, the page's own act ─────────────────────────────────
    where = at("paused");
    await openCard("paused");
    if ((await buttons.count()) !== 1 || (await text(buttons)) !== words.resume)
      throw new Error(`${where}: the card offers ${JSON.stringify(await buttons.allInnerTexts())}`);
    if (await only.count()) throw new Error(`${where}: a paused workflow is offered the approval`);
  } finally {
    page.off("response", noteRefused);
    await page.unroute(detailPattern, detail);
    await page.unroute(isPageApi, handler);
    // Leave the conversation as it was found: this stand filled the client's cache.
    await stand.visit(page, `chat/${conversation.id}`);
  }
}
