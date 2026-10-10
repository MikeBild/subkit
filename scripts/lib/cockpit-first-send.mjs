import { conversation, conversations, json, mockApi, uuid } from "./cockpit-journey-fixtures.mjs";
export async function assertFirstSendIsNeverLost(browser, stand) {
  const typed = "Bitte erstelle eine MCP-Verbindung zu meinem Dienst.";
  const awaiting = {
    ...conversation,
    id: "awaiting-form",
    title: "Wartet auf ein Formular",
    status: "awaiting_input",
    outcome: "awaiting_you",
    created_at: new Date(Date.now() - 30_000).toISOString(),
    updated_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
  };
  const run = async (label, handlePost, check) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "de-DE",
    });
    await context.addInitScript(() => localStorage.setItem("sk-cockpit-locale", "de"));
    const page = await context.newPage();
    const opened = [];
    let releaseList;
    const listHeld = new Promise((resolve) => {
      releaseList = resolve;
    });
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/v1/conversations" && request.method() === "GET") {
        await listHeld;
        const items = [awaiting, ...conversations.filter((entry) => entry.id !== uuid)];
        return json(route, { items, total: items.length });
      }
      if (path === "/v1/conversations" && request.method() === "POST") return handlePost(route);
      const detail = /^\/v1\/conversations\/([^/]+)$/.exec(path);
      if (detail && request.method() === "GET") opened.push(detail[1]);
      if (detail?.[1] === "created-quota")
        return json(route, {
          conversation: { ...conversation, id: "created-quota", title: null, surface: "web" },
          owner: { id: uuid, kind: "user", name: "operator@example.com" },
          created_resources: [],
          messages: [
            {
              id: "m1",
              role: "user",
              parts: [{ type: "text", text: typed }],
              model: null,
              created_at: new Date().toISOString(),
            },
          ],
          tool_calls: [],
          draft: { session: { permission_mode: "auto" } },
          last_turn_error: {
            code: "llm_provider_limited",
            kind: "quota_exhausted",
            retry_at: "2026-10-01T00:00:00.000Z",
            message: "You have reached your specified API usage limits.",
            at: new Date().toISOString(),
          },
          resume_summary: {
            active_target: { kind: "none", name: "none", slug: null, id: null, environment: null },
            stage: "onboarding",
            next_action: "",
            one_sentence: "",
            pending_approval: null,
          },
        });
      return mockApi(route);
    });
    await stand.visit(page, "chat/new", { waitUntil: "commit" });
    const field = page.locator('[data-testid="chat-composer-input"]');
    await field.waitFor({ state: "visible" });
    await field.fill(typed);
    await field.press("Enter");
    setTimeout(() => releaseList(), 300);
    await page.locator('[data-testid="chat-error"]').waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(500);
    try {
      await check(page, field, opened);
    } catch (error) {
      throw new Error(`first send (${label}): ${error.message}`, { cause: error });
    } finally {
      await context.close();
    }
  };

  await run(
    "refused before the engine saw it",
    (route) => route.abort("connectionrefused"),
    async (page, field, opened) => {
      if (opened.includes("awaiting-form"))
        throw new Error("the recovery opened a conversation this send did not create");
      if (!new URL(page.url()).pathname.endsWith("/chat/new"))
        throw new Error(`the page moved to ${page.url()}`);
      if ((await field.inputValue()) !== typed)
        throw new Error(`the composer holds ${JSON.stringify(await field.inputValue())}`);
    },
  );

  await run(
    "refused by the provider's usage limit",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `event: conversation_started\ndata: ${JSON.stringify({
            conversation: { ...conversation, id: "created-quota", title: null },
          })}\n\n` +
          `event: error\ndata: ${JSON.stringify({
            code: "llm_provider_limited",
            message:
              "You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.",
            details: { kind: "quota_exhausted", retry_at: "2026-10-01T00:00:00.000Z" },
          })}\n\n`,
      }),
    async (page, field) => {
      if (!new URL(page.url()).pathname.endsWith("/chat/created-quota"))
        throw new Error(`the page is on ${page.url()}, not on the conversation the send opened`);
      const transcript = await page.locator('[data-testid="chat-transcript"]').innerText();
      if (!transcript.includes(typed)) throw new Error("the request is not in the transcript");
      if ((await field.inputValue()) !== "")
        throw new Error("the request stands in the transcript AND the composer");
      const cause = await page.locator('[data-testid="chat-error-cause"]').innerText();
      if (!cause.includes("Nutzungslimit beim KI-Anbieter") || !cause.includes("2026"))
        throw new Error(`the cause reads ${JSON.stringify(cause)}`);
    },
  );
}
