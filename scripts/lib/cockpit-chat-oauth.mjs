/** A governed OAuth call remains actionable through both persisted pauses. */
export async function verifyChatOAuth(page, stand, conversation, locale) {
  await stand.visit(page, `chat/${conversation.id}`);
  const original = await page.evaluate(
    async (id) => (await fetch(`/v1/conversations/${id}`)).json(),
    conversation.id,
  );
  const origin = new URL(page.url()).origin;
  let stage = 0;
  let replies = 0;
  let visits = 0;
  const provider = "https://provider.example/authorize?state=fixture";
  const detailPattern = `**/v1/conversations/${conversation.id}`;
  const answerPattern = `**/v1/conversations/${conversation.id}/elicitations/oauth-*/respond`;
  const detail = (route) =>
    route.fulfill({
      json: {
        ...original,
        messages: [
          {
            id: "oauth-message",
            role: "assistant",
            created_at: conversation.updated_at,
            parts: [
              {
                type: "tool_call",
                call_id: "old-link",
                tool: "request_connector_reauth",
                input: {},
              },
              {
                type: "tool_result",
                call_id: "old-link",
                outcome: "ok",
                output: {
                  reauth_url: `${origin}/v1/connectors/00000000-0000-4000-8000-000000000001/oauth/start?grant=fixture`,
                  expires_at: "2000-01-01T00:00:00Z",
                },
              },
              {
                type: "tool_call",
                call_id: "oauth-call",
                tool: "authenticate_oauth",
                input: { connector_id: "connection" },
              },
              {
                type: "tool_result",
                call_id: "oauth-call",
                outcome: stage < 2 ? "pending" : "ok",
                output: { status: stage < 2 ? "awaiting_confirmation" : "authenticated" },
              },
            ],
          },
        ],
        tool_calls: [
          { id: "oauth-call", tool: "authenticate_oauth", input: { connector_id: "connection" } },
        ],
        resume_summary: {
          ...original.resume_summary,
          pending_approval:
            stage < 2
              ? {
                  id: `oauth-${stage}`,
                  tool_call_id: "oauth-call",
                  tool_name: "ask_user_confirm",
                  summary: "",
                  expires_at: "2099-01-01T00:00:00Z",
                  prompt: {
                    question: "Technical policy text must not be shown",
                    intent_kind: stage === 0 ? "execute_tool" : "oauth_completed",
                    ...(stage === 1 ? { authorization_url: provider } : {}),
                  },
                }
              : null,
        },
      },
    });
  const answer = (route) => {
    if (
      !route.request().url().endsWith(`/oauth-${stage}/respond`) ||
      route.request().postDataJSON()?.output?.confirmed !== true
    )
      throw new Error("OAuth answer lost its exact pending identity");
    if (stage === 1 && visits !== 1)
      throw new Error("OAuth completion submitted before sign-in action");
    stage++;
    replies++;
    return route.fulfill({
      contentType: "text/event-stream",
      body: `event: outcome\ndata: ${JSON.stringify({ conversation, status: stage < 2 ? "awaiting_input" : "active" })}\n\n`,
    });
  };
  const authorize = (route) => {
    visits++;
    return route.fulfill({ contentType: "text/html", body: "<h1>Provider sign-in</h1>" });
  };
  await page.route(detailPattern, detail);
  await page.route(answerPattern, answer);
  await page.context().route(provider, authorize);
  try {
    await stand.visit(page, `chat/${conversation.id}`);
    const card = page.getByTestId("chat-message-0-approval");
    await card.waitFor();
    // While the sign-in question waits, the reconnect card offers no button of
    // its own: answering the question in its card is the one way on.
    if (
      await page
        .getByRole("button", {
          name: locale === "de" ? "Anmeldung fortsetzen" : "Continue sign-in",
          exact: true,
        })
        .count()
    )
      throw new Error("A second way into the waiting sign-in question is offered");
    if (replies || visits) throw new Error("Showing an existing dialog must not submit anything");

    if ((await card.innerText()).includes("Technical policy"))
      throw new Error("Technical prompt leaked into sign-in dialog");
    await card
      .getByRole("button", {
        name: locale === "de" ? "Anmeldung vorbereiten" : "Prepare sign-in",
        exact: true,
      })
      .click();
    await page.getByTestId("chat-message-0-approval-sign-in").waitFor();
    if (visits || replies !== 1) throw new Error("Provider opened without a user click");
    await page.reload();
    const link = page.getByTestId("chat-message-0-approval-sign-in");
    await link.waitFor();
    if ((await link.getAttribute("href")) !== provider)
      throw new Error("Provider destination was rewritten");
    const popupPromise = page.waitForEvent("popup");
    await link.click();
    const popup = await popupPromise;
    await popup.getByRole("heading", { name: "Provider sign-in" }).waitFor();
    await popup.close();
    await card
      .getByRole("button", {
        name: locale === "de" ? "Anmeldung prüfen" : "Check sign-in",
        exact: true,
      })
      .click();
    await card.waitFor({ state: "hidden" });
    if (replies !== 2 || visits !== 1)
      throw new Error("Sign-in journey did not finish exactly once");
  } finally {
    await page.unroute(detailPattern, detail);
    await page.unroute(answerPattern, answer);
    await page.context().unroute(provider, authorize);
  }
}
