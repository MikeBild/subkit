/** Exercise the real SSE consumer with a controllable browser ReadableStream. */
export async function verifyChatActivity(page, stand, conversation, locale, capture) {
  await stand.visit(page, `chat/${conversation.id}`);
  const input = page.getByTestId("chat-composer-input");
  await input.waitFor();
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (url, options) => {
      if (options?.method === "POST" && String(url).endsWith("/messages")) {
        const stream = new ReadableStream({
          start(controller) {
            window.chatStream = controller;
          },
        });
        return Promise.resolve(
          new Response(stream, { headers: { "content-type": "text/event-stream" } }),
        );
      }
      return original(url, options);
    };
  });
  const emit = (event, data) =>
    page.evaluate(
      ({ event, data }) => {
        window.chatStream.enqueue(
          new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      },
      { event, data },
    );
  const edge = () =>
    page.waitForFunction(() => {
      const el = document.querySelector('[data-slot="message-scroller-viewport"]');
      return el && el.scrollHeight - el.clientHeight - el.scrollTop < 12;
    });
  await input.fill("Please explain this workflow.");
  await page.getByTestId("chat-composer-submit").click();
  const activity = page.getByTestId("chat-activity");
  await activity
    .getByText(locale === "de" ? "Ich denke nach …" : "Thinking…", { exact: true })
    .waitFor();
  await activity.locator('[data-slot="spinner"]').waitFor();
  await capture("thinking");
  await emit("message", {
    type: "tool_call_start",
    call_id: "activity-call",
    tool: "get_workflow",
  });
  await activity
    .getByText(locale === "de" ? "Ich bearbeite deine Anfrage …" : "Working on your request…", {
      exact: true,
    })
    .waitFor();
  await emit("message", { type: "tool_call_end", call_id: "activity-call" });
  await activity
    .getByText(locale === "de" ? "Ich denke nach …" : "Thinking…", { exact: true })
    .waitFor();
  await emit("message", { type: "text_delta", text: "A workflow explanation.\n\n".repeat(60) });
  await activity
    .getByText(locale === "de" ? "Ich schreibe die Antwort …" : "Writing the response…", {
      exact: true,
    })
    .waitFor();
  await edge();
  await emit("message", { type: "text_delta", text: "More detail.\n\n".repeat(20) });
  await edge();
  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  await viewport.hover();
  await page.mouse.wheel(0, -500);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-slot="message-scroller-viewport"]');
    return el.scrollHeight - el.clientHeight - el.scrollTop > 200;
  });
  const top = await viewport.evaluate((el) => el.scrollTop);
  await emit("message", {
    type: "text_delta",
    text: "New detail while reading history.\n\n".repeat(20),
  });
  await page.waitForTimeout(250);
  const after = await viewport.evaluate((el) => el.scrollTop);
  if (Math.abs(after - top) > 25) throw new Error("Streaming moved the reader away from history");
  await page.getByTestId("chat-scroll-bottom").click();
  await edge();
  await emit("message", { type: "text_delta", text: "Following again.\n\n".repeat(20) });
  await edge();
  await capture("following");
  await emit("outcome", { conversation, status: "active" });
  await page.evaluate(() => window.chatStream.close());
  await activity.waitFor({ state: "hidden" });
  await input.fill("Please continue.");
  await page.getByTestId("chat-composer-submit").click();
  await activity.waitFor();
  await emit("error", { message: "Fixture stream failure" });
  await page.evaluate(() => window.chatStream.close());
  await activity.waitFor({ state: "hidden" });
  await page.getByTestId("chat-error").waitFor();
}
