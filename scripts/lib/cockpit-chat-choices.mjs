/** The same canonical decision is available inline and in the working context. */
export async function verifyChatChoices(page, stand, conversation, locale, capture) {
  await stand.visit(page, `chat/${conversation.id}`);
  const original = await page.evaluate(
    async (id) => (await fetch(`/v1/conversations/${id}`)).json(),
    conversation.id,
  );
  const pending = {
    id: "choice-request",
    tool_call_id: "confirmation-call",
    tool_name: "ask_user_choice",
    expires_at: "2099-01-01T00:00:00Z",
  };
  const input = {
    question:
      locale === "de"
        ? "Wann soll der Bericht erscheinen?"
        : "When should the report be published?",
    options: [
      {
        value: "preview",
        label: locale === "de" ? "Montags (empfohlen)" : "Mondays (recommended)",
        description:
          locale === "de"
            ? "Der Bericht folgt auf die wöchentliche Sammlung."
            : "The report follows the weekly collection.",
      },
      {
        value: "cancel",
        label: locale === "de" ? "Dienstags" : "Tuesdays",
        description:
          locale === "de" ? "Ein zusätzlicher Tag für die Prüfung." : "An extra day for review.",
      },
    ],
  };
  let queueReads = 0;
  const trackQueue = (request) => {
    if (new URL(request.url()).pathname === "/v1/schedules") queueReads++;
  };
  page.on("request", trackQueue);
  let terminalStatus = "resolved";
  let waiting = true;
  let expired = false;
  let fail = false;
  let requests = 0;
  let release;
  let expected = "preview";
  const detailPattern = `**/v1/conversations/${conversation.id}`;
  const answerPattern = `**/v1/conversations/${conversation.id}/elicitations/choice-request/respond`;
  const detail = (route) =>
    route.fulfill({
      json: {
        ...original,
        messages: [
          {
            id: "choice-message",
            role: "assistant",
            created_at: conversation.updated_at,
            parts: [
              { type: "tool_call", call_id: pending.tool_call_id, tool: pending.tool_name, input },
              {
                type: "tool_result",
                call_id: pending.tool_call_id,
                output: { status: waiting ? "awaiting_input" : terminalStatus },
                outcome: waiting ? "pending" : terminalStatus === "resolved" ? "ok" : "denied",
              },
            ],
          },
        ],
        tool_calls: [{ id: pending.tool_call_id, tool: pending.tool_name, input }],
        resume_summary: {
          ...original.resume_summary,
          stage: waiting ? "awaiting_approval" : "onboarding",
          pending_approval: waiting
            ? { ...pending, expires_at: expired ? "2000-01-01T00:00:00Z" : pending.expires_at }
            : null,
        },
      },
    });
  const answer = async (route) => {
    requests++;
    if (
      JSON.stringify(route.request().postDataJSON()) !==
      JSON.stringify({ output: { value: expected } })
    )
      throw new Error("Choice was changed or sent to the wrong boundary");
    await new Promise((resolve) => {
      release = resolve;
    });
    if (fail)
      return route.fulfill({
        status: 409,
        json: { error: { code: "elicitation_already_resolved", message: "Already decided" } },
      });
    waiting = false;
    return route.fulfill({
      contentType: "text/event-stream",
      body: `event: message\ndata: {"type":"text_delta","text":"Decision received."}\n\nevent: outcome\ndata: ${JSON.stringify({ conversation, status: "active" })}\n\n`,
    });
  };
  await page.route(detailPattern, detail);
  await page.route(answerPattern, answer);
  try {
    for (const surface of ["inline", "context"]) {
      waiting = true;
      expected = surface === "inline" ? "preview" : "cancel";
      await stand.visit(page, `chat/${conversation.id}`);
      const inline = page.getByTestId("chat-message-0-choice");
      await inline.waitFor();
      if (/Freigabe|approval/i.test(await page.getByTestId("chat-summary").innerText()))
        throw new Error("Business question is mislabeled as authority in the chat header");
      if ((await inline.innerText()).includes("commit_intent"))
        throw new Error("Raw tool JSON replaced the decision UI");
      if (surface === "context") await page.getByTestId("chat-context-toggle").click();
      const card = surface === "context" ? page.getByTestId("chat-context-choice") : inline;
      if (
        surface === "context" &&
        /Wartet auf eine Freigabe|Waiting for an approval/.test(
          await page.getByTestId("chat-context").innerText(),
        )
      )
        throw new Error("Choice is mislabeled as an approval");
      const prefix = `${surface === "context" ? "chat-context" : "chat-message-0"}-choice`;
      const action = page.getByTestId(`${prefix}-submit`);
      if (!(await action.isDisabled())) throw new Error("Choice was implicitly selected");
      if (!(await page.getByTestId("chat-composer-input").isDisabled()))
        throw new Error("Unanswerable free-text composer remains active");
      for (const option of input.options) {
        if (!(await page.getByTestId(`${prefix}-option-${option.value}`).isVisible()))
          throw new Error("Business options are hidden behind another control");
        if (!(await card.innerText()).includes(option.description))
          throw new Error("Option effect is hidden before selection");
      }
      await page.getByTestId(`${prefix}-option-${expected}`).focus();
      await page.keyboard.press("Space");
      await page.waitForFunction(
        (prefix) => !document.querySelector(`[data-testid="${prefix}-submit"]`)?.disabled,
        prefix,
      );
      if (
        (await page.getByTestId(`${prefix}-option-${expected}`).getAttribute("aria-checked")) !==
        "true"
      )
        throw new Error("Selected business option is not marked");
      await capture(`${surface}-ready`);
      const before = requests;
      const queueBefore = queueReads;
      release = null;
      await action.click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-testid$="-choice-submit"]')].every(
          (el) => el.disabled,
        ),
      );
      if (!release) throw new Error("Canonical choice request was not sent");
      await action.dispatchEvent("click");
      if (requests !== before + 1) throw new Error("Duplicate choice request");
      await capture(`${surface}-busy`);
      release();
      await card.waitFor({ state: "hidden" });
      if (queueReads <= queueBefore)
        throw new Error("Decision queue was not refreshed after answering");
      if (surface === "context") await page.keyboard.press("Escape");
      await stand.visit(page, `chat/${conversation.id}`);
      if ((await page.getByTestId("chat-transcript").innerText()).includes("commit_intent"))
        throw new Error("Completed decision exposes technical parameters by default");
      await page
        .getByTestId("chat-transcript")
        .getByText(locale === "de" ? "Beantwortet" : "Answered", { exact: true })
        .waitFor();
      if (await inline.count())
        throw new Error("Completed decision still has active buttons after reload");
    }
    for (const state of ["timeout", "cancelled"]) {
      waiting = false;
      terminalStatus = state;
      await stand.visit(page, `chat/${conversation.id}`);
      await page
        .getByTestId("chat-transcript")
        .getByText(
          state === "timeout"
            ? locale === "de"
              ? "Rückfrage abgelaufen"
              : "Question expired"
            : locale === "de"
              ? "Rückfrage abgebrochen"
              : "Question cancelled",
          { exact: true },
        )
        .waitFor();
      if (await page.getByTestId("chat-message-0-choice").count())
        throw new Error("Closed choice remains actionable");
      await capture(state);
    }
    terminalStatus = "resolved";
    waiting = true;
    expired = true;
    await stand.visit(page, `chat/${conversation.id}`);
    await page.getByTestId("chat-message-0-choice").waitFor();
    if (!(await page.getByTestId("chat-message-0-choice-submit").isDisabled()))
      throw new Error("Expired request is actionable");
    await capture("expired");
    expired = false;
    fail = true;
    expected = "preview";
    await stand.visit(page, `chat/${conversation.id}`);
    await page.getByTestId("chat-message-0-choice-option-preview").click();
    release = null;
    await page.getByTestId("chat-message-0-choice-submit").click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="chat-message-0-choice-submit"]')?.disabled,
    );
    if (!release) throw new Error("Missing stale request");
    release();
    await page.getByTestId("chat-message-0-choice").getByRole("alert").waitFor();
    await capture("error");

    // The persisted pre-8.0.13 question keeps its response binding, but exposes
    // a readable recommendation and effects on both surfaces.
    waiting = true;
    fail = false;
    input.question =
      "Die Engine verlangt ein Dry-Run-Preview, bevor der Draft gespeichert werden kann. Write-Schritte (call_generate, call_publish, call_accept) werden dabei gehalten und nicht ausgeführt. Wie soll ich vorgehen?";
    input.options = [
      { value: "dryrun", label: "Dry-Run durchführen" },
      { value: "force", label: "force_commit verwenden" },
      { value: "cancel", label: "Abbrechen" },
    ];
    for (const surface of ["inline", "context"]) {
      await stand.visit(page, `chat/${conversation.id}`);
      if (surface === "context") await page.getByTestId("chat-context-toggle").click();
      const prefix = `${surface === "context" ? "chat-context" : "chat-message-0"}-choice`;
      const card = page.getByTestId(prefix);
      await card.waitFor();
      if (!/recommend|empfehlen/.test(await card.innerText()))
        throw new Error("Legacy preparation has no readable recommendation");
      if (!(await page.getByTestId(`${prefix}-submit`).isDisabled()))
        throw new Error("Recommendation selected an answer implicitly");
      const recommended = page.getByTestId(`${prefix}-option-dryrun`);
      if (!/recommended|empfohlen/.test(await recommended.innerText()))
        throw new Error("Recommended preparation option missing");
      await recommended.click();
      if (!/untested|ungetestet/.test(await card.innerText()))
        throw new Error("Held publication is misrepresented as tested");
      if (/force_commit|Dry-Run|call_publish/.test(await card.innerText()))
        throw new Error("Technical legacy choice text leaked");
      await capture(`${surface}-legacy-preparation`);
    }
  } finally {
    release?.();
    page.off("request", trackQueue);
    await page.unroute(detailPattern, detail);
    await page.unroute(answerPattern, answer);
  }
}
