/** The same canonical decision is available inline and in the working context. */
export async function verifyChatApprovals(page, stand, conversation, locale, capture) {
  await stand.visit(page, `chat/${conversation.id}`);
  const original = await page.evaluate(
    async (id) => (await fetch(`/v1/conversations/${id}`)).json(),
    conversation.id,
  );
  const pending = {
    id: "approval-request",
    tool_call_id: "confirmation-call",
    tool_name: "ask_user_confirm",
    expires_at: "2099-01-01T00:00:00Z",
  };
  const input = {
    question:
      locale === "de"
        ? "Geänderten Workflow als inaktive Version speichern?"
        : "Save the changed workflow as an inactive version?",
    commit_intent: { kind: "save_workflow_draft", description: "Schedule changed." },
  };
  let waiting = true;
  let expired = false;
  let fail = false;
  let requests = 0;
  let release;
  let expected = true;
  const detailPattern = `**/v1/conversations/${conversation.id}`;
  const answerPattern = `**/v1/conversations/${conversation.id}/elicitations/approval-request/respond`;
  const detail = (route) =>
    route.fulfill({
      json: {
        ...original,
        messages: [
          {
            id: "approval-message",
            role: "assistant",
            created_at: conversation.updated_at,
            parts: [
              { type: "tool_call", call_id: pending.tool_call_id, tool: pending.tool_name, input },
              {
                type: "tool_result",
                call_id: pending.tool_call_id,
                output: { status: waiting ? "awaiting_input" : "resolved" },
                outcome: waiting ? "pending" : expected ? "ok" : "denied",
                confirmation_state: waiting ? null : expected ? "confirmed" : "declined",
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
      JSON.stringify({ output: { confirmed: expected } })
    )
      throw new Error("Approval was changed or sent to the wrong boundary");
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
    // The card stands once, in the transcript: the working context holds no
    // copy, so there is one place to decide and one selection.
    for (const surface of ["inline", "inline-decline"]) {
      waiting = true;
      expected = surface === "inline";
      await stand.visit(page, `chat/${conversation.id}`);
      const inline = page.getByTestId("chat-message-0-approval");
      await inline.waitFor();
      if ((await inline.innerText()).includes("commit_intent"))
        throw new Error("Raw tool JSON replaced the decision UI");
      if (surface === "inline") {
        await page.getByTestId("chat-context-toggle").click();
        await page.getByTestId("chat-context").waitFor();
        if (
          await page
            .getByTestId("chat-context")
            .getByTestId(/-approval-approve$/)
            .count()
        )
          throw new Error("The working context repeats the approval card");
        await page.keyboard.press("Escape");
        await page.getByTestId("chat-context").waitFor({ state: "hidden" });
      }
      const card = inline;
      const action = card.getByTestId(
        `chat-message-0-approval-${expected ? "approve" : "decline"}`,
      );
      await capture(`${surface}-ready`);
      const before = requests;
      release = null;
      await action.click();
      await page.waitForFunction(() =>
        [
          ...document.querySelectorAll(
            '[data-testid$="-approval-approve"], [data-testid$="-approval-decline"]',
          ),
        ].every((el) => el.disabled),
      );
      if (!release) throw new Error("Canonical approval request was not sent");
      await action.dispatchEvent("click");
      if (requests !== before + 1) throw new Error("Duplicate approval request");
      await capture(`${surface}-busy`);
      release();
      await card.waitFor({ state: "hidden" });
      await stand.visit(page, `chat/${conversation.id}`);
      if ((await page.getByTestId("chat-transcript").innerText()).includes("commit_intent"))
        throw new Error("Completed decision exposes technical parameters by default");
      await page
        .getByTestId("chat-transcript")
        .getByText(
          expected
            ? locale === "de"
              ? "Freigegeben"
              : "Approved"
            : locale === "de"
              ? "Abgelehnt"
              : "Declined",
          { exact: true },
        )
        .waitFor();
      if (await inline.count())
        throw new Error("Completed decision still has active buttons after reload");
    }
    waiting = true;
    expired = true;
    await stand.visit(page, `chat/${conversation.id}`);
    await page.getByTestId("chat-message-0-approval").waitFor();
    if (!(await page.getByTestId("chat-message-0-approval-approve").isDisabled()))
      throw new Error("Expired request is actionable");
    await capture("expired");
    expired = false;
    fail = true;
    expected = true;
    await stand.visit(page, `chat/${conversation.id}`);
    release = null;
    await page.getByTestId("chat-message-0-approval-approve").click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="chat-message-0-approval-approve"]')?.disabled,
    );
    if (!release) throw new Error("Missing stale request");
    release();
    await page.getByTestId("chat-message-0-approval").getByRole("alert").waitFor();
    await capture("error");
  } finally {
    release?.();
    await page.unroute(detailPattern, detail);
    await page.unroute(answerPattern, answer);
  }
}
