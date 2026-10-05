import { assertSingleTriggers } from "./cockpit-single-trigger.mjs";
import { assertNoVisibleUuids } from "./cockpit-visible-uuids.mjs";

export async function verifyGateDiagnosis(page, stand, workflowId, locale, capture) {
  const de = locale === "de";
  const versionId = "018f4b4a-6d33-7b3a-9c2d-123456789ab8";
  const runId = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
  const candidateId = "7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d";
  const observedAt = new Date().toISOString();
  let current = true;
  let repaired = false;
  const repairBodies = [];
  const prepareBodies = [];

  const diagnosis = () => ({
    workflow_id: workflowId,
    workflow_version_id: versionId,
    environment: "prod",
    is_current: current,
    diagnoses: [
      {
        code: "execution_authority_changed",
        reason: "not_utf8",
        subject: { step_id: "send_email" },
        evidence: { execution_id: runId },
        remedy_kind: "patch",
        fixer: "use_utf8_encoder",
        ...(repaired ? { candidate_id: candidateId } : {}),
      },
      {
        code: "report_delivery_unprepared",
        subject: { step_id: "send_digest" },
        evidence: {},
        remedy_kind: "prepare",
      },
      {
        code: "dynamic_request",
        subject: { step_id: "post_webhook" },
        evidence: {},
        remedy_kind: "author",
      },
      {
        code: "report_delivery_contradicted",
        reason: "sent_on_a_sunday",
        subject: { step_id: "send_summary" },
        evidence: { execution_id: runId },
        remedy_kind: "author",
      },
    ],
  });

  const candidate = {
    id: candidateId,
    workflow_id: workflowId,
    workflow_name: "Monatsreport",
    tenant_id: workflowId,
    classification: "unsafe",
    status: "proposed",
    fixture_id: null,
    created_at: observedAt,
    updated_at: observedAt,
    connector_id: null,
    endpoint_key: "gate:execution_authority_changed",
    reviewable: true,
    review_reason: null,
    review_digest: "c".repeat(64),
    base_version_id: versionId,
    diff: {
      base_version_id: versionId,
      workflow_step_id: "compose",
      step_id: "send_email",
      execution_id: runId,
      environment: "prod",
      source: "gate_block",
      classification_reasons: ["gate_repair_requires_review"],
      drift_signal: {
        kind: "gate_block",
        code: "execution_authority_changed",
        reason: "not_utf8",
        step_id: "send_email",
        fixer: "use_utf8_encoder",
      },
      proposal: {
        kind: "gate_fix",
        classification: "unsafe",
        description: "Encode the message of step compose as UTF-8",
        reasoning: `The approval gate refused step \`send_email\` with \`execution_authority_changed\`; the use_utf8_encoder fixer computed this change from the saved definition and run ${runId}.`,
        patch: {
          fixer: "use_utf8_encoder",
          step_id: "compose",
          subject_step_id: "send_email",
          ops: [
            {
              op: "replace",
              path: "/expression",
              value: "return { raw: sk.base64UrlEncodeUtf8(msg) };",
            },
          ],
        },
      },
    },
  };

  const composeLines = [
    "const lines = [",
    '  "From: reports@example.test",',
    '  "To: team@example.test",',
    '  "Subject: Monatsreport",',
    '  "Content-Type: text/plain; charset=utf-8",',
    '  "",',
    "  input.body,",
    "];",
    'const msg = lines.join("\\r\\n");',
  ];
  const compose = (encoder) => ({
    id: "compose",
    kind: "transform",
    expression: [...composeLines, `return { raw: sk.${encoder}(msg) };`].join("\n"),
  });
  const preview = {
    ...candidate,
    candidate_id: candidateId,
    fixture_available: false,
    before_step: compose("base64UrlEncode"),
    after_step: compose("base64UrlEncodeUtf8"),
    changed_paths: ["expression"],
    proposal: candidate.diff.proposal,
    drift_summary: null,
  };

  const failedRun = {
    id: runId,
    workflow_id: workflowId,
    workflow_name: "Monatsreport",
    workflow_version_id: versionId,
    execution_authority_id: candidateId,
    hold_writes: false,
    source_kind: "saved",
    source_ref: null,
    status: "failed",
    request_source: "scheduler",
    parent_execution_id: null,
    started_at: observedAt,
    finished_at: observedAt,
    created_at: observedAt,
    failure: {
      step_key: "send_email",
      cause_class: "authority_mismatch",
      refusal_reason: "recipient_differs",
      connector: null,
    },
  };

  const reply = (route, body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === `/v1/workflows/${workflowId}/diagnosis`) {
      if (url.searchParams.get("environment") !== "prod")
        throw new Error(`Diagnosis asked in ${url.searchParams.get("environment")}, not prod`);
      return reply(route, diagnosis());
    }
    if (path === `/v1/workflows/${workflowId}/repairs` && request.method() === "POST") {
      repairBodies.push(request.postDataJSON());
      repaired = true;
      return reply(
        route,
        {
          candidate_id: candidateId,
          step_id: "send_email",
          fixer: "use_utf8_encoder",
          status: "proposed",
          created: true,
        },
        201,
      );
    }
    if (path === `/v1/workflows/${workflowId}/versions/${versionId}/prepare-authority`) {
      prepareBodies.push(request.postDataJSON());
      return reply(route, { prepared: true });
    }
    if (path === "/v1/executions" && url.searchParams.get("workflow_id") === workflowId)
      return reply(route, { items: [failedRun], total: 1, next_cursor: null });
    if (path === `/v1/patch-candidates/${candidateId}/preview`) return reply(route, preview);
    if (path === "/v1/patch-candidates")
      return reply(route, {
        items: repaired ? [candidate] : [],
        total: repaired ? 1 : 0,
        reviewable_total: repaired ? 1 : 0,
      });
    if (path === "/v1/skill-candidates")
      return reply(route, { items: [], total: 0, reviewable_total: 0 });
    if (path === "/v1/attention")
      return reply(route, {
        schema_version: "attention.v1",
        generated_at: observedAt,
        sources: Object.fromEntries(
          [
            "conversations",
            "schedules",
            "freshness",
            "failures",
            "patches",
            "connectors",
            "connections",
            "secret_approvals",
            "skills",
            "budget",
            "risk",
          ].map((source) => [source, "answered"]),
        ),
        status: { health_state: "critical", next_run_at: null },
        items: [
          {
            id: `workflow:${workflowId}`,
            class: "failing",
            severity: "urgent",
            kind: "workflow",
            subject: { kind: "workflow", id: workflowId, name: "Monatsreport" },
            reason: repaired ? "patch_proposed" : "execution_authority_changed",
            cause_class: "authority_mismatch",
            counts: repaired ? { patches: 1 } : {},
            since: observedAt,
            deadline: null,
            detail: null,
            actions: [
              {
                verb: "review",
                href: `/cockpit?review=workflow:${workflowId}`,
                primary: true,
                permission: "workflow:write",
              },
            ],
          },
        ],
      });
    return route.fallback();
  };
  const patterns = [
    `**/v1/workflows/${workflowId}/diagnosis*`,
    `**/v1/workflows/${workflowId}/repairs`,
    `**/v1/workflows/${workflowId}/versions/*/prepare-authority`,
    "**/v1/executions?*",
    "**/v1/patch-candidates**",
    "**/v1/skill-candidates**",
    "**/v1/attention*",
  ];
  for (const pattern of patterns) await page.route(pattern, handler);

  const shown = (testId) => page.getByTestId(testId).filter({ visible: true }).first();
  const item = (index) => shown(`workflow-diagnosis-${index}`);
  try {
    await stand.visit(page, `workflows/${workflowId}`);
    const section = page.getByTestId("workflow-diagnosis");
    await section.waitFor();
    if ((await section.locator("[data-code]").filter({ visible: true }).count()) !== 4)
      throw new Error("The diagnosis does not list every refused step as a row");
    if ((await section.locator("li, p.text-muted-foreground").count()) !== 0)
      throw new Error("The diagnosis stacks paragraphs instead of one row per step");
    const below = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="workflow-automation"]');
      const diagnosis = document.querySelector('[data-testid="workflow-diagnosis"]');
      return Boolean(strip && diagnosis && strip.nextElementSibling === diagnosis);
    });
    if (!below) throw new Error("The diagnosis does not stand right under the strip");
    if ((await page.getByTestId("workflow-diagnosis").count()) !== 1)
      throw new Error("The diagnosis stands on the page twice");
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="workflow-automation"]')
          ?.getAttribute("data-state") === "repair",
    );
    if (await page.getByTestId("workflow-automation-action").count())
      throw new Error("The panel repeats the diagnosis' act as a second button");
    if (await page.getByTestId("detail-action").count())
      throw new Error("The title repeats an act of the diagnosis");
    const repairs = await page
      .getByTestId("detail-workflows")
      .getByText(de ? "Automatisch reparieren" : "Repair automatically", { exact: true })
      .filter({ visible: true })
      .count();
    if (repairs !== 1) throw new Error(`The one computable repair is offered ${repairs} times`);
    const filled = await page
      .getByTestId("detail-workflows")
      .locator('button[data-variant="default"], a[data-variant="default"]')
      .allInnerTexts();
    if (filled.length !== 1 || filled[0].trim() !== (de ? "Ausführen" : "Run"))
      throw new Error(`The page's filled actions are ${JSON.stringify(filled)}`);
    const pageText = await page.getByTestId("detail-workflows").innerText();
    for (const stale of ["Freigabe prüfen", "Review approval"])
      if (pageText.includes(stale)) throw new Error(`The page still offers "${stale}"`);
    const jumps = await page
      .getByTestId("detail-workflows")
      .locator('a[href*="#workflow-automation"]')
      .count();
    if (jumps) throw new Error(`${jumps} link(s) on the page only lead to the automation panel`);
    if (await page.getByTestId("workflow-cause-remedy").count())
      throw new Error("The cause block offers a remedy the panel below it owns");
    await assertSingleTriggers(page, `${locale}/gate-diagnosis`, { approvalOpeners: 0 });

    const encoder = await shown("workflow-diagnosis-0-cause").innerText();
    const expected = de
      ? "Die Nachricht ist nicht korrekt als UTF-8 kodiert"
      : "The message is not correctly encoded as UTF-8";
    if (!encoder.includes(expected))
      throw new Error(`The encoder refusal is not said in words: ${encoder}`);
    if (encoder.includes("not_utf8")) throw new Error("The encoder refusal shows its code");
    const unknown = item(3).locator('[data-machine-value="true"]');
    if ((await unknown.innerText()) !== "sent_on_a_sunday")
      throw new Error("A reason this build cannot word is not shown as the engine's value");

    await shown("workflow-diagnosis-0-repair").waitFor();
    await shown("workflow-diagnosis-1-prepare").waitFor();
    const fixes = ["-repair", "-review", "-prepare", "-chat"];
    for (const index of [0, 1, 2, 3]) {
      const own = await section
        .locator(fixes.map((fix) => `[data-testid="workflow-diagnosis-${index}${fix}"]`).join(", "))
        .filter({ visible: true })
        .count();
      if (own !== 1) throw new Error(`Row ${index} offers ${own} fixes, not its one`);
    }
    const authorSteps = diagnosis()
      .diagnoses.filter((entry) => entry.remedy_kind === "author")
      .map((entry) => entry.subject.step_id);
    if (authorSteps.length !== 2) throw new Error("The fixture lost a step that needs an author");
    for (const [offset, step] of authorSteps.entries()) {
      const chat = await shown(`workflow-diagnosis-${2 + offset}-chat`).getAttribute("href");
      if (!chat?.includes("/cockpit/chat/new?") || !chat.includes(`workflow_id=${workflowId}`))
        throw new Error(`The author remedy does not open a chat about this workflow: ${chat}`);
      const asked = new URL(chat, "http://x").searchParams.get("prompt") ?? "";
      if (!asked.includes(step))
        throw new Error(`The conversation does not name step ${step}: ${asked}`);
    }

    await page.getByTestId("workflow-tabs-tab-history").click();
    const recent = page
      .getByTestId("workflow-recent-run-0-refusal-reason")
      .filter({ visible: true })
      .first();
    await recent.waitFor();
    const recentText = await recent.innerText();
    if (!recentText.includes(de ? "Empfänger weicht von der Freigabe ab" : "recipient differs"))
      throw new Error(`The recent run does not say which rule broke: ${recentText}`);
    await assertNoVisibleUuids(section, `${locale}/gate-diagnosis`);
    await section.scrollIntoViewIfNeeded();
    await capture("cause");

    await shown("workflow-diagnosis-1-prepare").click();
    await section.getByTestId("workflow-diagnosis-prepared").waitFor();
    if (prepareBodies.length !== 1 || JSON.stringify(prepareBodies[0]) !== '{"environment":"prod"}')
      throw new Error(`The trial run was not asked for exactly: ${JSON.stringify(prepareBodies)}`);

    await shown("workflow-diagnosis-0-repair").click();
    const sheet = page.getByTestId("attention-review");
    await sheet.waitFor();
    if (
      repairBodies.length !== 1 ||
      JSON.stringify(repairBodies[0]) !==
        '{"step_id":"send_email","fixer":"use_utf8_encoder","environment":"prod"}'
    )
      throw new Error(`The repair request is not exact: ${JSON.stringify(repairBodies)}`);
    const card = page.locator(`article[data-decision-key="patch:${candidateId}"]`);
    await card.waitFor();
    const change = card.locator('[data-testid$="-change"]');
    await change.waitFor();
    const added = await change.locator('[data-diff-line="added"]').allInnerTexts();
    const removed = await change.locator('[data-diff-line="removed"]').allInnerTexts();
    if (
      added.length !== 1 ||
      !added[0].includes("sk.base64UrlEncodeUtf8(msg)") ||
      removed.length !== 1 ||
      !removed[0].includes("sk.base64UrlEncode(msg)")
    )
      throw new Error(
        `The repair diff does not show the one changed line: -${removed.join("|")} +${added.join("|")}`,
      );
    if ((await change.locator("[data-diff-gap]").count()) === 0)
      throw new Error("The repair diff repeats the unchanged start instead of folding it");
    const changeText = await change.innerText();
    if (!changeText.includes(de ? "Ursache" : "Cause") || !changeText.includes(expected))
      throw new Error(`The repair does not name the refused rule in words: ${changeText}`);
    const header = page.getByTestId("attention-review-actions");
    await header.getByTestId("authority-grant-open").waitFor();
    const headerButtons = await header.locator("button").filter({ visible: true }).count();
    if (headerButtons !== 2)
      throw new Error(
        `The repair sheet header offers ${headerButtons} buttons, not one act and a menu`,
      );
    const title = (await card.locator('[data-testid$="-title"]').innerText()).trim();
    if (title !== (de ? "Nachricht als UTF-8 kodieren" : "Encode the message as UTF-8"))
      throw new Error(`The repair card repeats the sheet title or is not worded: ${title}`);
    await card.locator('[data-testid$="-toggle"]').click();
    await card.locator('[data-testid$="-detail"]').waitFor();
    const sheetText = await sheet.innerText();
    for (const raw of [
      "gate:",
      "execution_authority_changed",
      "gate_repair_requires_review",
      "use_utf8_encoder",
      "The approval gate refused",
      "Encode the report message",
    ])
      if (sheetText.includes(raw)) throw new Error(`The repair sheet shows "${raw}"`);
    await assertNoVisibleUuids(sheet, `${locale}/gate-diagnosis-review`);
    await capture("repair-review");
    await header.getByTestId("authority-grant-open").click();
    const environment = page.getByTestId("authority-environment");
    await environment.waitFor();
    const chosen = (await environment.innerText()).trim();
    if (chosen !== (de ? "Produktion" : "Production"))
      throw new Error(`The repair of a production run opens its approval for ${chosen}`);
    const grantText = await page.getByTestId("authority-grant-dialog").innerText();
    if (grantText.includes('"before"') || grantText.includes('"after"'))
      throw new Error("The repair approval shows its change as raw JSON");
    await page.getByTestId("authority-grant-cancel").click();
    await page.getByTestId("authority-grant-dialog").waitFor({ state: "hidden" });
    await page.goBack();
    await sheet.waitFor({ state: "hidden" });

    await stand.visit(page, `workflows/${workflowId}`);
    await shown("workflow-diagnosis-0-review").waitFor();
    if (await page.getByTestId("workflow-diagnosis-0-repair").count())
      throw new Error("A filed repair is offered for filing again");
    await page.waitForLoadState("networkidle");
    const reviews = await page
      .getByTestId("detail-workflows")
      .getByText(de ? "Reparatur prüfen" : "Review the repair", { exact: true })
      .filter({ visible: true })
      .count();
    if (reviews !== 1) throw new Error(`Reviewing the filed repair is offered ${reviews} times`);
    await assertSingleTriggers(page, `${locale}/gate-diagnosis-filed`, { approvalOpeners: 0 });

    current = false;
    repaired = false;
    await stand.visit(page, `workflows/${workflowId}`);
    await shown("workflow-diagnosis-0-note").waitFor();
    if (await page.getByTestId("workflow-diagnosis-0-repair").count())
      throw new Error("A draft's diagnosis offers a repair the engine would refuse");
    if (repairBodies.length !== 1) throw new Error("Visiting the page filed a repair");
  } finally {
    for (const pattern of patterns) await page.unroute(pattern, handler);
  }
}
