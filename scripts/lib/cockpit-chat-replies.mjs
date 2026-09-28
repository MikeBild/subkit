/** Reproduce the production text-question deadlock through the real chat composer. */
export async function verifyChatReplies(page, stand, conversation, locale, capture) {
  await stand.visit(page, `chat/${conversation.id}`);
  await page.getByTestId("chat-composer-input").waitFor();
  const original = await page.evaluate(
    async (id) => (await fetch(`/v1/conversations/${id}`)).json(),
    conversation.id,
  );
  const pending = {
    id: "text-question",
    tool_name: "ask_user_text",
    tool_call_id: "text-question-call",
    summary: "Which colour?",
    expires_at: "2099-01-01T00:00:00Z",
  };
  let waiting = true;
  let stale = false;
  let kind = "ask_user_text";
  let appends = 0;
  let answers = 0;
  const detailPattern = `**/v1/conversations/${conversation.id}`;
  const appendPattern = `**/v1/conversations/${conversation.id}/messages`;
  const answerPattern = `**/v1/conversations/${conversation.id}/elicitations/text-question/respond`;
  const detail = (route) =>
    route.fulfill({
      json: {
        ...original,
        tool_calls: [
          { id: pending.tool_call_id, tool: kind, input: { question: pending.summary } },
        ],
        messages: [
          {
            id: "question-message",
            role: "assistant",
            created_at: conversation.updated_at,
            parts: [
              { type: "text", text: pending.summary },
              {
                type: "tool_call",
                call_id: pending.tool_call_id,
                tool: kind,
                input: { question: pending.summary },
              },
              {
                type: "tool_result",
                call_id: pending.tool_call_id,
                output: { status: waiting ? "awaiting_input" : "resolved" },
                outcome: waiting ? "pending" : "ok",
              },
            ],
          },
        ],
        conversation: { ...original.conversation, status: waiting ? "awaiting_input" : "active" },
        resume_summary: {
          ...original.resume_summary,
          stage: waiting ? "awaiting_approval" : "onboarding",
          pending_approval: waiting && !stale ? { ...pending, tool_name: kind } : null,
        },
      },
    });
  const append = (route) => {
    appends += 1;
    return route.fulfill({
      contentType: "text/event-stream",
      body: `event: error\ndata: ${JSON.stringify({ code: "pending_elicitation_blocked", message: "resolve the pending dialog", details: { pending_elicitation: { ...pending, tool_name: kind } } })}\n\n`,
    });
  };
  const answer = (route) => {
    answers += 1;
    const body = route.request().postDataJSON();
    if (
      JSON.stringify(body) !== JSON.stringify({ output: { value: "Blau, bitte nur vorbereiten." } })
    )
      throw new Error("Text reply was changed or interpreted as a grant");
    waiting = false;
    return route.fulfill({
      contentType: "text/event-stream",
      body: `event: outcome\ndata: ${JSON.stringify({ conversation, status: "active" })}\n\n`,
    });
  };
  await page.route(detailPattern, detail);
  await page.route(appendPattern, append);
  await page.route(answerPattern, answer);
  try {
    for (const raced of [false, true]) {
      waiting = true;
      stale = raced;
      await stand.visit(page, `chat/${conversation.id}`);
      const input = page.getByTestId("chat-composer-input");
      await input.waitFor();
      if (!raced) {
        await page.getByTestId("chat-reply-hint").waitFor();
        if (
          await page
            .getByTestId("chat-transcript")
            .locator('[data-testid$="-approve"], [data-testid$="-decline"]')
            .count()
        )
          throw new Error("A text question displays binary approval actions");
        // "Wartet auf dich" once, amber (§2), in the header badge — not red
        // there and amber in the list, and not repeated under the title.
        const status = page.getByTestId("chat-status");
        if (
          (await status.getAttribute("data-waiting")) !== "true" ||
          (await status.getAttribute("class"))?.includes("destructive")
        )
          throw new Error("The waiting badge is not the amber waiting state");
        if (/wartet|waiting/i.test(await page.getByTestId("chat-summary").innerText()))
          throw new Error("The summary line repeats that the conversation is waiting");
        await capture("question");
      }
      await input.fill("Blau, bitte nur vorbereiten.");
      await page.getByTestId("chat-composer-submit").click();
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="chat-composer-input"]');
        return el && !el.disabled && !el.value;
      });
      if (await page.getByTestId("chat-error").isVisible())
        throw new Error("Answering a text question displayed an error");
      await page.getByTestId("chat-reply-hint").waitFor({ state: "hidden" });
    }
    if (answers !== 2 || appends !== 1)
      throw new Error(`Wrong reply routing: answers=${answers}, appends=${appends}`);
    waiting = true;
    stale = true;
    kind = "ask_user_confirm";
    await stand.visit(page, `chat/${conversation.id}`);
    await page.getByTestId("chat-composer-input").fill("ja");
    await page.getByTestId("chat-composer-submit").click();
    const error = page.getByTestId("chat-error");
    await error.waitFor();
    if (!(await error.innerText()).includes(locale === "de" ? "offene Rückfrage" : "open question"))
      throw new Error("A pending question was mislabelled as a connection failure");
    if (answers !== 2) throw new Error("A typed yes was converted into structured approval");
    if (!(await page.getByTestId("chat-composer-submit").isEnabled()))
      throw new Error("A failed request prevents retrying");
    if (await page.getByTestId("chat-composer-submit").locator(".lucide-x").count())
      throw new Error("Retrying a message looks like cancelling it");
  } finally {
    await page.unroute(detailPattern, detail);
    await page.unroute(appendPattern, append);
    await page.unroute(answerPattern, answer);
  }
}
