import { assertNoVisibleUuids } from "./cockpit-visible-uuids.mjs";

/**
 * A workflow the approval gate holds, on its own page: each refused step says
 * WHY in the reader's words, and the act that removes it is offered where the
 * cockpit can perform it — "Automatisch reparieren" files the engine's
 * deterministic repair and opens it in the review sheet, a step that needs a
 * trial run offers one, and one that needs an author leads to the chat.
 *
 * Hostile on purpose: a reason this build has no sentence for (shown as the
 * engine's value, never blank), run and candidate ids that must stay off the
 * screen, a run list whose newest failure names the broken rule, and a second
 * pass where the diagnosed version is a draft — there the repair button must
 * be absent, because the engine would refuse it.
 *
 * Persistence and authorization of the repair are covered by the engine's
 * gate-repair tests; this checks what a person sees and what the page sends.
 */
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
        // A rule a newer engine names and this build has no sentence for.
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
      source: "gate_block",
      drift_signal: { kind: "gate_block", step_id: "send_email", fixer: "use_utf8_encoder" },
      proposal: {
        kind: "gate_fix",
        classification: "unsafe",
        description: "Encode the message of step compose as UTF-8",
        // The engine's own wording names the run by id — the card must not.
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

  const item = (index) => page.getByTestId(`workflow-diagnosis-${index}`);
  try {
    await stand.visit(page, `workflows/${workflowId}`);
    const section = page.getByTestId("workflow-diagnosis");
    await section.waitFor();
    if ((await section.locator("li[data-code]").count()) !== 4)
      throw new Error("The diagnosis does not list every refused step");

    // The cause, in the reader's words — the precise rule, not the code.
    const encoder = await item(0).getByTestId("workflow-diagnosis-0-cause").innerText();
    const expected = de
      ? "Die Nachricht ist nicht korrekt als UTF-8 kodiert"
      : "The message is not correctly encoded as UTF-8";
    if (!encoder.includes(expected))
      throw new Error(`The encoder refusal is not said in words: ${encoder}`);
    if (encoder.includes("not_utf8")) throw new Error("The encoder refusal shows its code");
    // A reason without a sentence: the engine's value, marked — never blank.
    const unknown = item(3).locator('[data-machine-value="true"]');
    if ((await unknown.innerText()) !== "sent_on_a_sunday")
      throw new Error("A reason this build cannot word is not shown as the engine's value");

    // Each block offers the act that removes it, and only that.
    await item(0).getByTestId("workflow-diagnosis-0-repair").waitFor();
    await item(1).getByTestId("workflow-diagnosis-1-prepare").waitFor();
    await item(2).getByTestId("workflow-diagnosis-2-chat").waitFor();
    if (await item(1).getByTestId("workflow-diagnosis-1-repair").count())
      throw new Error("A block without a fixer offers an automatic repair");
    if (await item(2).getByTestId("workflow-diagnosis-2-repair").count())
      throw new Error("A block that needs an author offers an automatic repair");
    const chat = await item(2).getByTestId("workflow-diagnosis-2-chat").getAttribute("href");
    if (!chat?.includes("/cockpit/chat/new?") || !chat.includes(`workflow_id=${workflowId}`))
      throw new Error(`The author remedy does not open a chat about this workflow: ${chat}`);

    // The run list names the broken rule beside the class.
    const recent = page.getByTestId("workflow-recent-run-0-refusal-reason");
    await recent.waitFor();
    const recentText = await recent.innerText();
    if (!recentText.includes(de ? "Empfänger weicht von der Freigabe ab" : "recipient differs"))
      throw new Error(`The recent run does not say which rule broke: ${recentText}`);
    await assertNoVisibleUuids(section, `${locale}/gate-diagnosis`);
    await section.scrollIntoViewIfNeeded();
    await capture("cause");

    // A trial run is asked for in the environment the approval is judged in.
    await item(1).getByTestId("workflow-diagnosis-1-prepare").click();
    await item(1).getByTestId("workflow-diagnosis-1-note").waitFor();
    if (prepareBodies.length !== 1 || JSON.stringify(prepareBodies[0]) !== '{"environment":"prod"}')
      throw new Error(`The trial run was not asked for exactly: ${JSON.stringify(prepareBodies)}`);

    // The repair is filed — step, fixer and environment, nothing else — and
    // opens in the review sheet, where a person previews and approves it.
    await item(0).getByTestId("workflow-diagnosis-0-repair").click();
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
    if (!(await card.locator('[data-testid$="-approve"]').isDisabled()))
      throw new Error("The filed repair can be approved before it was opened");
    await assertNoVisibleUuids(sheet, `${locale}/gate-diagnosis-review`);
    await capture("repair-review");
    await page.goBack();
    await sheet.waitFor({ state: "hidden" });

    // Once filed, the page leads to the open repair instead of filing again.
    await stand.visit(page, `workflows/${workflowId}`);
    await item(0).getByTestId("workflow-diagnosis-0-review").waitFor();
    if (await item(0).getByTestId("workflow-diagnosis-0-repair").count())
      throw new Error("A filed repair is offered for filing again");

    // A draft is diagnosed, never repaired: the engine would refuse it.
    current = false;
    repaired = false;
    await stand.visit(page, `workflows/${workflowId}`);
    await item(0).getByTestId("workflow-diagnosis-0-note").waitFor();
    if (await item(0).getByTestId("workflow-diagnosis-0-repair").count())
      throw new Error("A draft's diagnosis offers a repair the engine would refuse");
    if (repairBodies.length !== 1) throw new Error("Visiting the page filed a repair");
  } finally {
    for (const pattern of patterns) await page.unroute(pattern, handler);
  }
}
