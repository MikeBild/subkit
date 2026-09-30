/**
 * The side panel beside a workflow answers every question: with words, with
 * the card the turn handed over, or with a sentence that no answer came and
 * a way into the conversation. Never an empty space under the question.
 *
 * The engine journey pins the other half: a review with nothing to show is
 * no card, and the model writes the answer.
 */
export async function verifyAgentPanel(page, stand, workflowId, _locale) {
  const conversationId = "00000000-0000-4000-8000-000000000601";
  const conversation = {
    id: conversationId,
    title: "Zu diesem Workflow",
    status: "active",
    target_workflow_id: workflowId,
    updated_at: new Date().toISOString(),
  };
  const reviewTurn = {
    id: "panel-review",
    role: "assistant",
    model: null,
    created_at: conversation.updated_at,
    parts: [
      {
        type: "dynamic-tool",
        toolName: "review_workflow_automation",
        toolCallId: "panel-review-call",
        state: "output-available",
        input: { workflow_id: workflowId },
        output: {
          ok: true,
          data: {
            kind: "workflow_automation_review",
            presentation: "automation_readiness_card",
            workflow_id: workflowId,
            schedules: [],
            inbound_hooks: [
              {
                workflow_id: workflowId,
                slug: "watchkit-findings",
                environment: "prod",
                state: "approval_required",
                ready: false,
                review: { eligible_for_repeated_runs: false },
              },
            ],
          },
        },
      },
    ],
  };
  const silentTurn = {
    id: "panel-silent",
    role: "assistant",
    model: null,
    created_at: conversation.updated_at,
    parts: [{ type: "text", text: "" }],
  };
  let recorded = [reviewTurn];
  let refuse = false;
  const outcome = (route) =>
    refuse
      ? route.fulfill({ status: 500, json: { code: "internal_error", message: "boom" } })
      : route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          // An outcome and nothing else: the turn streamed no words.
          body: `event: outcome\ndata: ${JSON.stringify({ conversation, status: "active" })}\n\n`,
        });
  const start = (route) =>
    route.request().method() === "POST" ? outcome(route) : route.fallback();
  const detail = (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            conversation,
            messages: [
              {
                id: "question",
                role: "user",
                model: null,
                created_at: conversation.updated_at,
                parts: [{ type: "text", text: "Was muss hier repariert werden?" }],
              },
              ...recorded,
            ],
            tool_calls: [],
          },
        })
      : route.fallback();
  const routes = [
    ["**/v1/conversations", start],
    [`**/v1/conversations/${conversationId}/messages`, outcome],
    [`**/v1/conversations/${conversationId}`, detail],
  ];
  for (const [pattern, handler] of routes) await page.route(pattern, handler);
  const ask = async (question) => {
    await page.getByTestId("agent-panel-input").fill(question);
    await page.getByTestId("agent-panel-send").click();
  };
  try {
    await stand.visit(page, `workflows/${workflowId}`);
    await page.getByTestId("agent-panel-open").click();
    const panel = page.getByTestId("agent-panel");
    await panel.waitFor();

    // A turn that answered with the automation card: the card, in the panel.
    await ask("Was muss hier repariert werden?");
    await panel.getByTestId("agent-panel-question-0").waitFor();
    const card = panel.getByTestId("chat-automation-tool");
    await card.waitFor();
    await card.getByTestId("chat-automation-tool-review").waitFor();

    // A turn that left no words and no card: said so, with the way in.
    // The earlier card is still in the conversation; it must not stand in
    // for this turn's missing answer.
    recorded = [
      reviewTurn,
      {
        id: "follow-up",
        role: "user",
        model: null,
        created_at: conversation.updated_at,
        parts: [{ type: "text", text: "Und jetzt?" }],
      },
      silentTurn,
    ];
    await ask("Und jetzt?");
    const none = panel.getByTestId("agent-panel-no-answer-1");
    await none.waitFor();
    if ((await card.count()) !== 1)
      throw new Error("The silent turn repeated the previous turn's card as its answer");
    const href = await panel.getByTestId("agent-panel-conversation-1").getAttribute("href");
    if (!href?.includes(`/chat/${conversationId}`))
      throw new Error(`The silent turn does not link its conversation: ${href}`);

    // A turn that failed outright: the failure, not an empty space.
    refuse = true;
    await ask("Noch einmal?");
    await panel.getByTestId("agent-panel-error").waitFor();

    // Every question has something under it.
    const questions = await panel.locator('[data-testid^="agent-panel-question-"]').count();
    for (let index = 0; index < 2; index++) {
      const answered =
        (await panel.getByTestId(`agent-panel-answer-${index}`).count()) +
        (await panel.getByTestId(`agent-panel-no-answer-${index}`).count()) +
        (index === 0 ? await card.count() : 0);
      if (answered === 0) throw new Error(`Question ${index} of ${questions} has an empty answer`);
    }
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
  } finally {
    for (const [pattern, handler] of routes) await page.unroute(pattern, handler);
  }
}
