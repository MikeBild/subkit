export async function verifyChatHeader(page, stand, conversation, locale, capture) {
  const de = locale === "de";
  await stand.visit(page, `chat/${conversation.id}`);
  await page.getByTestId("chat-composer-input").waitFor();
  const tokenUsage = page.getByTestId("chat-usage-tokens");
  const costUsage = page.getByTestId("chat-usage-cost");
  await Promise.all([tokenUsage.waitFor(), costUsage.waitFor()]);
  const tokenText = (await tokenUsage.innerText()).trim();
  const costText = (await costUsage.innerText()).trim();
  if (!tokenText.includes(de ? "gewichtete Tokens" : "weighted tokens"))
    throw new Error(
      `the chat token label does not identify weighted tokens: ${JSON.stringify(tokenText)}`,
    );
  if (!costText.startsWith(de ? "Modellkosten · mind." : "Model cost · at least"))
    throw new Error(`the chat cost label is not an approximate floor: ${JSON.stringify(costText)}`);
  const costTitle = await costUsage.getAttribute("title");
  if (!costTitle?.includes(de ? "ohne Preis" : "no rate"))
    throw new Error(
      `the partly priced cost lacks its missing-rate explanation: ${JSON.stringify(costTitle)}`,
    );
  const original = await page.evaluate(
    async (id) => (await fetch(`/v1/conversations/${id}`)).json(),
    conversation.id,
  );
  const state = { title: original.conversation.title, hidden: false, run: true };
  const record = () => ({ ...original.conversation, title: state.title, hidden: state.hidden });
  const runSummary = {
    active_target: {
      kind: "workflow",
      name: "Growth report",
      slug: "growth-report",
      id: null,
      environment: null,
    },
    stage: "run_focus",
    focused_run: {
      execution_id: "header-run",
      status: "failed",
      recorded_at: "2026-09-01T08:00:00.000Z",
    },
    last_successful_probe: null,
    last_successful_preview: null,
    unsaved: false,
    pending_approval: null,
    next_action: "Ask what went wrong in this run, or how to repair it.",
    one_sentence: "You are looking into a run of workflow.",
  };
  const detailPattern = `**/v1/conversations/${conversation.id}`;
  const detail = async (route) => {
    const request = route.request();
    if (request.method() === "PATCH") {
      state.title = JSON.parse(request.postData() ?? "{}").title ?? state.title;
      return route.fulfill({ json: record() });
    }
    if (request.method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        ...original,
        conversation: record(),
        tool_calls: [],
        messages: [
          {
            id: "header-answer",
            role: "assistant",
            model: null,
            created_at: original.conversation.updated_at,
            parts: [
              {
                type: "text",
                text: de
                  ? "Der Lauf scheiterte an zwei Stellen:\n\n- Abruf der Kennzahlen\n- Versand des Berichts"
                  : "The run failed in two places:\n\n- Fetching the figures\n- Sending the report",
              },
            ],
          },
        ],
        resume_summary: state.run ? runSummary : original.resume_summary,
      },
    });
  };
  await page.route(detailPattern, detail);
  try {
    await stand.visit(page, `chat/${conversation.id}`);
    const summary = page.getByTestId("chat-summary");
    await summary.waitFor();
    const said = await summary.innerText();
    const expected = de
      ? "Du untersuchst den Lauf von „Growth report“ vom"
      : "You are looking into the run of “Growth report” from";
    if (!said.startsWith(expected))
      throw new Error(`a chat opened for a run says "${said}" instead of naming the run`);
    if (/gespeichert|saved/i.test(said))
      throw new Error(`a chat opened for a run claims a save: "${said}"`);
    if ((await page.getByTestId("chat-status").count()) > 0)
      throw new Error(
        `an idle chat about a run carries the badge "${await page.getByTestId("chat-status").innerText()}"`,
      );
    const items = page.getByTestId("chat-transcript").locator("li");
    await items.first().waitFor();
    const itemCount = await items.count();
    if (itemCount !== 2) throw new Error(`the chat list rendered ${itemCount} items`);
    await capture("run-focus");

    const title = page.getByTestId("chat-title");
    const renamed = de ? "Umbenannt im Kopf" : "Renamed in the header";
    await page.getByTestId("chat-menu").click();
    await page.getByTestId("chat-rename").click();
    const renameSubmit = page.getByTestId("conversation-rename-dialog-submit");
    if ((await renameSubmit.innerText()).trim() !== (de ? "Umbenennen" : "Rename"))
      throw new Error("the chat rename dialog must use the Umbenennen verb");
    await page.getByTestId("conversation-rename-title").fill(renamed);
    await page.getByTestId("conversation-rename-dialog-submit").click();
    await page.getByTestId("conversation-rename-dialog").waitFor({ state: "hidden" });
    await page.waitForFunction(
      (value) =>
        document.querySelector('[data-testid="chat-title"]')?.textContent?.trim() === value,
      renamed,
      { timeout: 10_000 },
    );
    if ((await title.innerText()).trim() !== renamed)
      throw new Error("the header kept the old title after renaming");
    await capture("renamed");

    state.hidden = true;
    const hiddenResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/v1/conversations/${conversation.id}` &&
        response.request().method() === "GET" &&
        response.status() === 200,
    );
    await stand.visit(page, `chat/${conversation.id}`);
    if (!(await (await hiddenResponse).json()).conversation.hidden)
      throw new Error("the hidden-conversation fixture was not fetched");
    await page.getByTestId("chat-title").waitFor();
    await page.getByTestId("chat-menu").click();
    const menu = page.getByRole("menu");
    await menu.waitFor({ state: "visible" });
    const expectedActions = de ? ["Umbenennen", "Löschen"] : ["Rename", "Delete"];
    const actions = (await menu.getByRole("menuitem").allTextContents()).map((value) =>
      value.trim(),
    );
    if (JSON.stringify(actions) !== JSON.stringify(expectedActions))
      throw new Error(
        `the conversation header exposes unexpected actions: ${JSON.stringify(actions)}`,
      );
    if (await page.getByTestId(/^(chat-hide|chat-unhide)$/).count())
      throw new Error("the conversation header still offers a hidden-state action");
    await capture("hidden-menu");
    await page.getByTestId("chat-delete").click();
    const deletion = page.getByTestId("conversation-delete-dialog");
    await deletion.waitFor({ state: "visible" });
    const consequence = de
      ? `„${renamed}“ wird endgültig entfernt.`
      : `“${renamed}” is removed for good.`;
    await deletion.getByText(consequence, { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await deletion.waitFor({ state: "hidden" });
    if (!state.hidden) throw new Error("opening and cancelling deletion changed hidden state");
  } finally {
    await page.unroute(detailPattern, detail);
  }
}
