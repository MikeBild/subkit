import { conversation, json, uuid } from "./cockpit-journey-fixtures.mjs";

export async function verifyNewConversationJourney(page, stand) {
  const createdId = "018f4b4a-6d33-7b3a-9c2d-123456789ac1";
  const prompt = "Erstelle einen neuen Berichtsentwurf für die Funktionsprüfung.";
  const existing = { ...conversation, id: uuid, title: "Bestehende Unterhaltung" };
  const created = {
    ...conversation,
    id: createdId,
    title: "Neuer Berichtsentwurf",
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    last_message_role: "user",
    last_message_excerpt: prompt,
  };
  const rows = [existing];
  let createdTurns = 0;
  let listReads = 0;
  let createdDetailReads = 0;
  const messages = () => [
    {
      id: "new-conversation-user-message",
      role: "user",
      model: null,
      created_at: created.created_at,
      parts: [{ type: "text", text: prompt }],
    },
  ];
  const detail = () => ({
    conversation: { ...created, surface: "web" },
    owner: { id: uuid, kind: "user", name: "operator@example.com" },
    created_resources: [],
    messages: messages(),
    tool_calls: [],
    draft: { session: { permission_mode: "auto" } },
    resume_summary: {
      active_target: { kind: "none", name: "none", slug: null, id: null, environment: null },
      stage: "onboarding",
      next_action: "",
      one_sentence: "",
      pending_approval: null,
    },
  });
  const handle = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/v1/conversations" && request.method() === "GET") {
      const hidden = url.searchParams.get("hidden") === "only";
      if (hidden) return json(route, { items: [], total: 0 });
      listReads += 1;
      if (
        rows.length !== (createdTurns ? 2 : 1) ||
        rows.filter((row) => row.id === createdId).length !== (createdTurns ? 1 : 0) ||
        rows.filter((row) => row.id === uuid).length !== 1
      )
        throw new Error("conversation list does not contain exactly the existing and new chat");
      return json(route, { items: [...rows], total: rows.length });
    }
    if (path === "/v1/conversations" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (body.initial_message !== prompt)
        throw new Error("first turn did not preserve the new conversation message");
      if (rows.some((row) => row.id === createdId))
        throw new Error("new conversation was created more than once");
      createdTurns += 1;
      rows.unshift(created);
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `event: conversation_started\ndata: ${JSON.stringify({
            type: "conversation_started",
            conversation: created,
          })}\n\n` +
          `event: outcome\ndata: ${JSON.stringify({ conversation: created, events: [], status: "active" })}\n\n`,
      });
    }
    if (path === `/v1/conversations/${createdId}` && request.method() === "GET") {
      createdDetailReads += 1;
      return json(route, detail());
    }
    if (path === `/v1/conversations/${uuid}` && request.method() === "GET")
      return json(route, {
        conversation: { ...existing, surface: "web" },
        owner: { id: uuid, kind: "user", name: "operator@example.com" },
        created_resources: [],
        messages: [],
        tool_calls: [],
        draft: { session: { permission_mode: "auto" } },
        resume_summary: {
          active_target: { kind: "none", name: "none", slug: null, id: null, environment: null },
          stage: "onboarding",
          next_action: "",
          one_sentence: "",
          pending_approval: null,
        },
      });
    return route.fallback();
  };
  await page.route("**/v1/conversations**", handle);
  try {
    await stand.visit(page, `chat/${uuid}`);
    const newButton = page.getByTestId("conversation-new");
    await newButton.waitFor({ state: "visible" });
    await newButton.click();
    if (!new URL(page.url()).pathname.endsWith("/chat/new"))
      throw new Error("new-conversation action did not open a blank chat");
    await newButton.waitFor({ state: "visible" });
    if ((await newButton.getAttribute("data-variant")) !== "default")
      throw new Error("new conversation is not the primary action on a blank chat");
    if ((await newButton.innerText()).trim() !== "Neue Unterhaltung")
      throw new Error("the visible primary action is not labeled Neue Unterhaltung");
    const field = page.getByTestId("chat-composer-input");
    await field.fill(prompt);
    await page.getByTestId("chat-composer-submit").click();
    await page.waitForURL((url) => url.pathname.endsWith(`/chat/${createdId}`));
    await page.getByTestId("chat-transcript").getByText(prompt, { exact: true }).waitFor();
    await page.getByTestId("conversation-list").getByText("Neuer Berichtsentwurf").waitFor();
    await page.getByTestId("conversation-list").getByText("Bestehende Unterhaltung").waitFor();
    if (createdTurns !== 1 || rows.filter((row) => row.id === uuid).length !== 1)
      throw new Error("first turn duplicated or altered the existing conversation");

    const priorListReads = listReads;
    const priorCreatedDetailReads = createdDetailReads;
    await page.reload();
    await page.getByTestId("chat-transcript").getByText(prompt, { exact: true }).waitFor();
    await page.getByTestId("conversation-list").getByText("Neuer Berichtsentwurf").waitFor();
    await page.getByTestId("conversation-list").getByText("Bestehende Unterhaltung").waitFor();
    if (
      !new URL(page.url()).pathname.endsWith(`/chat/${createdId}`) ||
      createdTurns !== 1 ||
      listReads <= priorListReads ||
      createdDetailReads <= priorCreatedDetailReads
    )
      throw new Error("conversation identity or list state changed after reload");
  } finally {
    await page.unroute("**/v1/conversations**", handle);
  }
}
