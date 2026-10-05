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

export async function verifyChatDecidedApproval(page, stand, conversation, locale, capture) {
  await stand.visit(page, `chat/${conversation.id}`);
  const original = await page.evaluate(
    async (id) => (await fetch(`/v1/conversations/${id}`)).json(),
    conversation.id,
  );
  const effect = {
    connector: "Reporting API",
    method: "PATCH",
    target: "https://api.example/v1/reports",
  };
  const call = {
    id: "gated-call",
    tool: "call_connector",
    input: { connector_id: "connector-gated", method: "PATCH", path: "/v1/reports" },
    parent_message_id: "gated-message",
  };
  const pending = {
    id: "gated-request",
    tool_call_id: call.id,
    tool_name: "ask_user_confirm",
    summary: "Reporting API: PATCH https://api.example/v1/reports",
    expires_at: "2099-01-01T00:00:00Z",
    prompt: {
      question: "Reporting API: PATCH https://api.example/v1/reports — approve this call?",
      intent_kind: "execute_confirmed_tool_call",
      effect,
    },
  };
  let decided = false;
  const detailPattern = `**/v1/conversations/${conversation.id}`;
  const detail = (route) =>
    route.fulfill({
      json: {
        ...original,
        messages: [
          {
            id: "gated-message",
            role: "assistant",
            created_at: conversation.updated_at,
            parts: [
              { type: "tool_call", call_id: call.id, tool: call.tool, input: call.input },
              {
                type: "tool_result",
                call_id: call.id,
                tool: call.tool,
                output: decided
                  ? { status: "resolved", elicitation_id: pending.id }
                  : { pending: true, status: "awaiting_confirmation" },
                outcome: decided ? "ok" : "pending",
              },
            ],
          },
          ...(decided
            ? [
                {
                  id: "gated-decision",
                  role: "user",
                  created_at: conversation.updated_at,
                  parts: [
                    {
                      type: "text",
                      text: "✓ Approved: call_connector",
                      decision: { state: "confirmed", tool: "call_connector" },
                    },
                  ],
                },
              ]
            : []),
        ],
        tool_calls: decided
          ? [
              { ...call, confirmation_state: "confirmed", outcome: "ok" },
              {
                id: "gated-auto-persist",
                tool: "call_connector",
                input: { _harness_auto_persist: true },
                parent_message_id: null,
                confirmation_state: "declined",
                outcome: "error",
                output: { ok: false, source: "harness_auto_persist" },
              },
            ]
          : [call],
        resume_summary: {
          ...original.resume_summary,
          stage: decided ? "onboarding" : "awaiting_approval",
          pending_approval: decided ? null : pending,
        },
      },
    });
  const waitingLabel = locale === "de" ? "Wartet auf dich" : "Waiting for you";
  await page.route(detailPattern, detail);
  try {
    await stand.visit(page, `chat/${conversation.id}`);
    const card = page.getByTestId("chat-message-0-approval");
    await card.waitFor();
    const line = await card.innerText();
    const expected =
      locale === "de"
        ? "Reporting API aufrufen: PATCH https://api.example/v1/reports"
        : "Call Reporting API: PATCH https://api.example/v1/reports";
    if (!line.includes(expected)) throw new Error(`Gated call is not described: ${line}`);
    for (const raw of ["call_connector", "Policy requires", "approve this call"])
      if (line.includes(raw)) throw new Error(`Decision card shows engine wording: ${raw}`);
    if (!(await page.getByTestId("chat-status").innerText()).includes(waitingLabel))
      throw new Error("An open decision does not say that it waits for the person");
    await capture("gated-ready");
    decided = true;
    await card.waitFor({ state: "hidden", timeout: 15_000 });
    const status = page.getByTestId("chat-status");
    if ((await status.count()) && (await status.innerText()).includes(waitingLabel))
      throw new Error("A decision made elsewhere still shows the conversation as waiting");
    if (await page.getByTestId(/-approval-approve$/).count())
      throw new Error("A decided approval still offers its buttons");
    const transcript = await page.getByTestId("chat-transcript").innerText();
    const verdict = locale === "de" ? "Deine Entscheidung: Freigegeben" : "Your decision: Approved";
    if (!transcript.includes(verdict)) throw new Error("The recorded decision is not shown");
    for (const raw of ["call_connector", "✓ Approved"])
      if (transcript.includes(raw)) throw new Error(`Transcript shows engine wording: ${raw}`);
    await capture("gated-decided");
  } finally {
    await page.unroute(detailPattern, detail);
  }
}
