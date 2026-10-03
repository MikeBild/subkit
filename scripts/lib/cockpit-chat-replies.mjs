/**
 * A free-text question (`ask_user_text`) is on screen and answered on purpose.
 *
 * Production showed the opposite: the question rode in a collapsed tool row,
 * the composer's placeholder was the only trace of it, and every reply the
 * reader wrote — "ich sehe hier keinen dialog" — was taken as the answer. The
 * fixture therefore sends what the engine sends: no prose repeating the
 * question, an empty `summary`, the question in `prompt.question` and the
 * placeholder only in the call's input.
 */
export async function verifyChatReplies(page, stand, conversation, locale, capture) {
  await stand.visit(page, `chat/${conversation.id}`);
  await page.getByTestId("chat-composer-input").waitFor();
  const original = await page.evaluate(
    async (id) => (await fetch(`/v1/conversations/${id}`)).json(),
    conversation.id,
  );
  const de = locale === "de";
  const question = de
    ? "Wie soll dein Workflow heißen? Ein kurzer, sprechender Name genügt."
    : "What should your workflow be called? A short, descriptive name is enough.";
  const placeholder = "Example API Data Fetch";
  const pending = {
    id: "text-question",
    tool_name: "ask_user_text",
    tool_call_id: "text-question-call",
    expires_at: "2099-01-01T00:00:00Z",
  };
  const later = new Date(Date.parse(conversation.updated_at) + 60_000).toISOString();
  const state = {
    // "tool": asked through the ask_user_text tool; "prose": the assistant
    // asked in prose and the harness parked it — no tool call at all.
    mode: "tool",
    kind: "ask_user_text",
    asked: true,
    waiting: true,
    // The snapshot predates the question: the page cannot know it yet.
    stale: false,
    answer: null,
    // What the next append does: refuse because a question waits, or run a
    // turn that ends on a question.
    append: "blocked",
  };
  let appends = 0;
  let answers = 0;
  let expected = "";
  const input = { question, placeholder };
  const detailPattern = `**/v1/conversations/${conversation.id}`;
  const appendPattern = `**/v1/conversations/${conversation.id}/messages`;
  const answerPattern = `**/v1/conversations/${conversation.id}/elicitations/text-question/respond`;
  const detail = (route) => {
    const tool = state.mode === "tool";
    const parts = !state.asked
      ? [{ type: "text", text: de ? "Ich lege das an." : "I will set that up." }]
      : tool
        ? [
            { type: "tool_call", call_id: pending.tool_call_id, tool: state.kind, input },
            {
              type: "tool_result",
              call_id: pending.tool_call_id,
              output: state.answer
                ? { status: "resolved", elicitation_id: pending.id }
                : { status: "awaiting_input" },
              outcome: state.answer ? "ok" : "pending",
            },
          ]
        : [{ type: "text", text: question }];
    return route.fulfill({
      json: {
        ...original,
        tool_calls:
          tool && state.asked
            ? [
                {
                  id: pending.tool_call_id,
                  conversation_id: conversation.id,
                  tool: state.kind,
                  input,
                  output: state.answer
                    ? { status: "resolved", elicitation_id: pending.id }
                    : { status: "awaiting_input" },
                },
              ]
            : [],
        messages: [
          {
            id: "question-message",
            role: "assistant",
            model: null,
            created_at: conversation.updated_at,
            parts,
          },
          ...(state.answer
            ? [
                {
                  id: pending.id,
                  role: "user",
                  model: null,
                  created_at: later,
                  parts: [{ type: "text", text: state.answer }],
                },
              ]
            : []),
        ],
        conversation: {
          ...original.conversation,
          status: state.waiting ? "awaiting_input" : "active",
        },
        resume_summary: {
          ...original.resume_summary,
          stage: state.waiting ? "awaiting_approval" : "onboarding",
          pending_approval:
            state.waiting && state.asked && !state.stale
              ? {
                  ...pending,
                  tool_name: state.kind,
                  tool_call_id: tool ? pending.tool_call_id : null,
                  // The engine's summary for these rows is empty, or a
                  // generic line for a parked prose question: never the
                  // question, so nothing may read it as one.
                  summary: tool ? "" : "the assistant asked a question",
                  prompt: { question },
                }
              : null,
        },
      },
    });
  };
  const append = (route) => {
    appends += 1;
    if (state.append === "turn") {
      // A turn that ends on a question: the stream says nothing about it but
      // the outcome; the next read of the conversation carries it.
      state.asked = true;
      state.waiting = true;
      return route.fulfill({
        contentType: "text/event-stream",
        body: `event: outcome\ndata: ${JSON.stringify({ conversation, status: "awaiting_input" })}\n\n`,
      });
    }
    // The engine refuses the append while a question waits; the question
    // reaches the page with the next read.
    state.stale = false;
    state.asked = true;
    state.waiting = true;
    return route.fulfill({
      contentType: "text/event-stream",
      body: `event: error\ndata: ${JSON.stringify({ code: "pending_elicitation_blocked", message: "resolve the pending dialog", details: { pending_elicitation: { ...pending, tool_name: state.kind } } })}\n\n`,
    });
  };
  const answer = (route) => {
    answers += 1;
    const body = route.request().postDataJSON();
    if (JSON.stringify(body) !== JSON.stringify({ output: { value: expected } }))
      throw new Error(
        `Text reply was changed or interpreted as a grant: ${JSON.stringify(body)} (expected ${expected})`,
      );
    state.waiting = false;
    state.answer = expected;
    return route.fulfill({
      contentType: "text/event-stream",
      body: `event: outcome\ndata: ${JSON.stringify({ conversation, status: "active" })}\n\n`,
    });
  };
  const reset = (patch) => {
    Object.assign(state, {
      mode: "tool",
      kind: "ask_user_text",
      asked: true,
      waiting: true,
      stale: false,
      answer: null,
      append: "blocked",
      ...patch,
    });
  };
  const transcript = () => page.getByTestId("chat-transcript");
  const questionCard = () => transcript().locator('[data-testid$="text-question"]').first();
  const composer = () => page.getByTestId("chat-composer-input");
  const composerReady = () =>
    page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="chat-composer-input"]');
      return el && !el.disabled && !el.value;
    });
  /** The question is on screen, with a field and an action to answer it. */
  const expectQuestionShown = async (where) => {
    const card = questionCard();
    await card.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      throw new Error(`${where}: the text question is not shown in the transcript`);
    });
    if (!(await card.innerText()).includes(question))
      throw new Error(`${where}: the question card does not show the question`);
    const field = card.locator('[data-testid$="text-question-input"]');
    if (!(await field.isVisible())) throw new Error(`${where}: the question has no answer field`);
    const submit = card.locator('[data-testid$="text-question-submit"]');
    if ((await submit.innerText()).trim() !== (de ? "Antworten" : "Answer"))
      throw new Error(`${where}: the answer action is not named "${de ? "Antworten" : "Answer"}"`);
    // The composer says, naming the question, that the next message answers it.
    const hint = page.getByTestId("chat-composer-hint");
    if (!(await hint.isVisible()))
      throw new Error(`${where}: the composer does not say that it answers the question`);
    const hintText = await hint.innerText();
    if (!hintText.includes(question.slice(0, 30)))
      throw new Error(`${where}: the composer hint does not name the question: ${hintText}`);
    if (await transcript().locator('[data-testid$="-approve"], [data-testid$="-decline"]').count())
      throw new Error(`${where}: a text question displays binary approval actions`);
    return { card, field, submit };
  };
  /** The answered question still reads as question + answer. */
  const expectAnswered = async (value) => {
    await page.waitForFunction(
      () =>
        !document.querySelector('[data-testid="chat-transcript"] [data-testid$="text-question"]'),
    );
    const asked = transcript().locator('[data-testid*="-asked-"]');
    await asked.waitFor();
    if (!(await asked.innerText()).includes(question))
      throw new Error("The answered question is no longer readable");
    if (!(await asked.innerText()).includes(de ? "Beantwortet" : "Answered"))
      throw new Error("The answered question does not say it was answered");
    const marker = transcript().locator('[data-testid$="-answer-to"]');
    if (!(await marker.isVisible()))
      throw new Error("The reply is not marked as the answer to the question");
    // The marker can render a frame before the refetched reply text does;
    // wait for the words rather than reading the transcript once.
    await page
      .waitForFunction(
        (expected) =>
          (document.querySelector('[data-testid="chat-transcript"]')?.textContent ?? "").includes(
            expected,
          ),
        value,
        { timeout: 10_000 },
      )
      .catch(() => {
        throw new Error("The answer is not shown in the transcript");
      });
  };
  await page.route(detailPattern, detail);
  await page.route(appendPattern, append);
  await page.route(answerPattern, answer);
  try {
    // 1. Asked through the tool: question card, placeholder, "Antworten".
    reset({});
    await stand.visit(page, `chat/${conversation.id}`);
    await composer().waitFor();
    const shown = await expectQuestionShown("tool question");
    if ((await shown.field.getAttribute("placeholder")) !== placeholder)
      throw new Error("The answer field does not carry the question's placeholder");
    // "Wartet auf dich" once, amber (§2), in the header badge — not red
    // there and amber in the list, and not repeated under the title.
    // The badge is a state (`StatusBadge`): its tone is the pattern's own
    // reading of the state, not a class a page chose.
    const status = page.getByTestId("chat-status");
    if (
      (await status.getAttribute("data-state")) !== "awaiting_input" ||
      (await status.getAttribute("data-tone")) !== "warn"
    )
      throw new Error("The waiting badge is not the amber waiting state");
    if (/wartet|waiting/i.test(await page.getByTestId("chat-summary").innerText()))
      throw new Error("The summary line repeats that the conversation is waiting");
    await capture("question");
    expected = "Tagesbericht Kunden-API";
    await shown.field.fill(expected);
    await shown.submit.click();
    await expectAnswered(expected);
    if (await page.getByTestId("chat-composer-hint").count())
      throw new Error("The composer still claims a question waits after it was answered");
    await capture("answered");

    // 2. Answered from the composer, which said it would.
    reset({});
    await stand.visit(page, `chat/${conversation.id}`);
    await expectQuestionShown("composer answer");
    expected = "Blau, bitte nur vorbereiten.";
    await composer().fill(expected);
    await page.getByTestId("chat-composer-submit").click();
    await composerReady();
    if (await page.getByTestId("chat-error").isVisible())
      throw new Error("Answering a text question displayed an error");
    await expectAnswered(expected);

    // 3. The question arrived after the page read the conversation. A message
    //    written without seeing it is NOT its answer: the page refuses, keeps
    //    the text and shows the question.
    reset({ stale: true, asked: false });
    await stand.visit(page, `chat/${conversation.id}`);
    await composer().waitFor();
    if (await questionCard().count()) throw new Error("A question is shown before it was asked");
    const unseen = de ? "ich sehe hier keinen dialog" : "I don't see any dialog here";
    await composer().fill(unseen);
    await page.getByTestId("chat-composer-submit").click();
    const error = page.getByTestId("chat-error");
    await error.waitFor();
    if (!(await error.innerText()).includes(de ? "Rückfrage wartet" : "question is waiting"))
      throw new Error("A refused message does not say that a question waits");
    if (answers !== 2)
      throw new Error("A message written before the question was shown was taken as its answer");
    await page.waitForFunction(
      (text) => document.querySelector('[data-testid="chat-composer-input"]')?.value === text,
      unseen,
    );
    await expectQuestionShown("raced question");
    await capture("raced");
    expected = "Kundenbericht";
    await composer().fill(expected);
    await page.getByTestId("chat-composer-submit").click();
    await composerReady();
    await expectAnswered(expected);

    // 4. Asked in prose and parked by the harness: no tool row to stand
    //    beside, the question is still shown and answerable.
    reset({ mode: "prose" });
    await stand.visit(page, `chat/${conversation.id}`);
    await composer().waitFor();
    const parked = await expectQuestionShown("prose question");
    if ((await parked.card.getAttribute("data-testid")) !== "chat-text-question")
      throw new Error("A parked prose question is not shown below the transcript");
    expected = "Wetterdaten";
    await parked.field.fill(expected);
    await parked.submit.click();
    await page.waitForFunction(
      () =>
        !document.querySelector('[data-testid="chat-transcript"] [data-testid$="text-question"]'),
    );

    // 5. A turn that ends on a question shows it without a reload.
    reset({ asked: false, waiting: false, append: "turn" });
    await stand.visit(page, `chat/${conversation.id}`);
    await composer().waitFor();
    await composer().fill(de ? "Lege einen Workflow an" : "Create a workflow");
    await page.getByTestId("chat-composer-submit").click();
    await expectQuestionShown("streamed question");

    if (answers !== 4 || appends !== 2)
      throw new Error(`Wrong reply routing: answers=${answers}, appends=${appends}`);

    // 6. A typed "ja" never becomes a structured confirmation.
    reset({ kind: "ask_user_confirm", stale: true });
    await stand.visit(page, `chat/${conversation.id}`);
    await composer().fill("ja");
    await page.getByTestId("chat-composer-submit").click();
    await error.waitFor();
    if (!(await error.innerText()).includes(de ? "offene Rückfrage" : "open question"))
      throw new Error("A pending question was mislabelled as a connection failure");
    if (answers !== 4) throw new Error("A typed yes was converted into structured approval");
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
