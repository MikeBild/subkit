export async function verifyChatHeader(page, stand, conversation, locale, capture) {
  const de = locale === "de";
  await stand.visit(page, `chat/${conversation.id}`);
  await page.getByTestId("chat-composer-input").waitFor();
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
  const hidePattern = `**/v1/conversations/${conversation.id}/hide`;
  const unhidePattern = `**/v1/conversations/${conversation.id}/unhide`;
  const hide = (route) => {
    state.hidden = true;
    return route.fulfill({ json: record() });
  };
  const unhide = (route) => {
    state.hidden = false;
    return route.fulfill({ json: record() });
  };
  await page.route(detailPattern, detail);
  await page.route(hidePattern, hide);
  await page.route(unhidePattern, unhide);
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
    const mode = page.getByTestId("chat-permission-mode");
    if ((await mode.count()) > 0) {
      const drawnAsButton = await mode.evaluate((el) => {
        const style = getComputedStyle(el);
        return style.borderTopStyle !== "none" && Number.parseFloat(style.borderTopWidth) > 0;
      });
      if (drawnAsButton) throw new Error("the mode of a running chat is drawn like a button");
    }
    const items = page.getByTestId("chat-transcript").locator("li");
    await items.first().waitFor();
    const markers = await items.evaluateAll((nodes) =>
      nodes.map((node) => {
        const list = node.closest("ul, ol");
        const style = list ? getComputedStyle(list) : null;
        return {
          type: style?.listStyleType ?? "none",
          position: style?.listStylePosition ?? "outside",
          padding: Number.parseFloat(style?.paddingLeft ?? "0"),
        };
      }),
    );
    if (markers.length !== 2) throw new Error(`the chat list rendered ${markers.length} items`);
    for (const marker of markers)
      if (marker.type === "none" || (marker.position !== "inside" && marker.padding < 12))
        throw new Error(`a chat list item shows no bullet (${JSON.stringify(marker)})`);
    await capture("run-focus");

    const title = page.getByTestId("chat-title");
    const renamed = de ? "Umbenannt im Kopf" : "Renamed in the header";
    await page.getByTestId("chat-menu").click();
    await page.getByTestId("chat-rename").click();
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
    await stand.visit(page, `chat/${conversation.id}`);
    await page.getByTestId("chat-title").waitFor();
    await page.getByTestId("chat-menu").click();
    await page.getByTestId("chat-unhide").waitFor();
    if ((await page.getByTestId("chat-hide").count()) > 0)
      throw new Error("a hidden conversation still offers to be hidden");
    await capture("hidden-menu");
    await page.getByTestId("chat-unhide").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="chat-unhide"]'));
    await page.getByTestId("chat-menu").click();
    await page.getByTestId("chat-hide").waitFor();
    if (state.hidden) throw new Error("showing the conversation again did not reach the engine");
    await page.keyboard.press("Escape");
  } finally {
    await page.unroute(detailPattern, detail);
    await page.unroute(hidePattern, hide);
    await page.unroute(unhidePattern, unhide);
  }
}
