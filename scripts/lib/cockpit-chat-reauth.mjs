export async function verifyChatReauth(page, stand, conversation) {
  await stand.visit(page, `chat/${conversation.id}`);
  const original = await page.evaluate(
    async (id) => (await fetch(`/v1/conversations/${id}`)).json(),
    conversation.id,
  );
  const origin = new URL(page.url()).origin;
  const id = "5f47b19e-e8ec-42c7-b757-6dd4f1121ac1";
  const href = `${origin}/v1/connectors/${id}/oauth/start?grant=synthetic-ui-test`;
  let expired = false;
  const detailPattern = `**/v1/conversations/${conversation.id}`;
  const sendPattern = `**/v1/conversations/${conversation.id}/messages`;
  let renewals = 0;
  let visits = 0;
  const detail = (route) =>
    route.fulfill({
      json: {
        ...original,
        tool_calls: [],
        conversation: { ...original.conversation, status: "active" },
        resume_summary: { ...original.resume_summary, pending_approval: null },
        messages: [
          {
            id: "reauth-message",
            role: "assistant",
            created_at: conversation.updated_at,
            parts: [
              {
                type: "tool_call",
                call_id: "reauth",
                tool: "request_connector_reauth",
                input: { connector_id: id },
              },
              {
                type: "tool_result",
                call_id: "reauth",
                outcome: "ok",
                output: {
                  ok: true,
                  data: {
                    connector: "mail",
                    reauth_url: href,
                    expires_at: expired ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z",
                  },
                },
              },
              {
                type: "text",
                text: `Anmelden: ${href}\n\n[Verbindung öffnen](${href.replace("https:", "http:")})`,
              },
            ],
          },
        ],
      },
    });
  const start = (route) => {
    visits++;
    if (route.request().url() !== href) throw new Error("OAuth target was rewritten");
    return route.fulfill({ contentType: "text/html", body: "<h1>Provider sign-in</h1>" });
  };
  const renew = (route) => {
    const body = route.request().postDataJSON();
    if (
      body.references?.length !== 1 ||
      body.references[0].id !== id ||
      body.references[0].type !== "connector"
    )
      throw new Error("Renewal lost connector identity");
    renewals++;
    return route.fulfill({
      contentType: "text/event-stream",
      body: `event: outcome\ndata: ${JSON.stringify({ conversation, status: "active" })}\n\n`,
    });
  };
  await page.route(detailPattern, detail);
  await page.route(sendPattern, renew);
  await page.context().route(href, start);
  try {
    await stand.visit(page, `chat/${conversation.id}`);
    const action = page.getByTestId("chat-reauth-open");
    await action.waitFor();
    if ((await action.getAttribute("href")) !== href)
      throw new Error("Structured sign-in target changed");
    const links = page.getByTestId("message-link");
    if ((await links.count()) !== 2) throw new Error("Bare or markdown sign-in link missing");
    for (const link of await links.all())
      if ((await link.getAttribute("href")) !== "#chat-account-connection")
        throw new Error("Model-generated link bypassed the structured sign-in card");
    if ((await page.getByTestId("chat-transcript").innerText()).includes("synthetic-ui-test"))
      throw new Error("Sign-in token leaked into the visible link label");
    if (visits) throw new Error("Rendering consumed a single-use grant");
    const popupPromise = page.waitForEvent("popup");
    await action.click();
    const popup = await popupPromise;
    await popup.getByRole("heading", { name: "Provider sign-in" }).waitFor();
    await popup.close();
    if (visits !== 1) throw new Error("Click did not open the exact sign-in route once");
    expired = true;
    await stand.visit(page, `chat/${conversation.id}`);
    await page.getByTestId("chat-reauth-renew").waitFor();
    if (await page.getByTestId("chat-reauth-open").count())
      throw new Error("Expired grant remains actionable");
    await page.getByTestId("chat-reauth-renew").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="chat-activity"]'));
    if (renewals !== 1) throw new Error("Renewal did not use one conversation turn");
  } finally {
    await page.unroute(detailPattern, detail);
    await page.unroute(sendPattern, renew);
    await page.context().unroute(href, start);
  }
}
