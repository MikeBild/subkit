const FAILURES = [
  {
    route: "people",
    api: "/v1/identity/users",
    failed: "people-load-failed",
    notShown: ["people-empty", "people-list"],
  },
  {
    route: "settings",
    api: "/v1/settings",
    failed: "settings-load-failed",
    notShown: ["settings-list"],
  },
];

const exactPath = (path) => (url) => new URL(url).pathname === path;

const refuse = (route) =>
  route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "internal", message: "fixture refuses this read" } }),
  });

async function expectFailure(page, where, failed, notShown) {
  await page.getByTestId(failed).waitFor({ state: "visible", timeout: 10_000 });
  for (const testId of notShown) {
    if (
      await page
        .getByTestId(testId)
        .isVisible()
        .catch(() => false)
    )
      throw new Error(`${where}: a failed read still renders "${testId}" beside the failure`);
  }
  if (!(await page.getByTestId(`${failed}-retry`).isVisible()))
    throw new Error(`${where}: the failure offers no retry`);
}

export async function verifyLoadFailures(page, stand, conversation, capture) {
  for (const { route, api, failed, notShown } of FAILURES) {
    const matcher = exactPath(api);
    await page.route(matcher, refuse);
    try {
      await stand.visit(page, route);
      await expectFailure(page, `/${route}`, failed, notShown);
      await capture(route);
    } finally {
      await page.unroute(matcher, refuse);
    }
  }

  const detail = exactPath(`/v1/conversations/${conversation.id}`);
  await page.route(detail, refuse);
  try {
    await stand.visit(page, `chat/${conversation.id}`);
    await expectFailure(page, "/chat/<id>", "chat-load-failed", [
      "chat-empty",
      "chat-composer-area",
    ]);
    if (!(await page.getByTestId("conversation-new").isVisible()))
      throw new Error("/chat/<id>: a conversation that cannot be opened offers no way on");
    if (!(await listReachable(page)))
      throw new Error("/chat/<id>: a conversation that cannot be opened offers no way to the list");
    const title = (await page.getByTestId("chat-title").innerText()).trim();
    if (title === "Neue Unterhaltung" || title === "New conversation")
      throw new Error("/chat/<id>: the header titles a failed conversation as a new one");
    await capture("chat");
  } finally {
    await page.unroute(detail, refuse);
  }

  const missing = (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "not_found", message: "conversation not found" } }),
    });
  await page.route(detail, missing);
  try {
    await stand.visit(page, `chat/${conversation.id}`);
    const failed = page.getByTestId("chat-load-failed");
    await failed.waitFor({ state: "visible", timeout: 10_000 });
    const text = await failed.innerText();
    if (
      !/gibt es nicht oder du hast keinen Zugriff|does not exist or you have no access/.test(text)
    )
      throw new Error(
        `/chat/<unknown>: the failure does not say the conversation is missing — "${text}"`,
      );
    if (/Lad die Seite neu|Refresh the page/.test(text))
      throw new Error(
        "/chat/<unknown>: tells the reader to reload for a conversation that is not there",
      );
    if (
      await page
        .getByTestId("chat-load-failed-retry")
        .isVisible()
        .catch(() => false)
    )
      throw new Error("/chat/<unknown>: offers a retry that cannot help");
    if (!(await listReachable(page)))
      throw new Error('/chat/<unknown>: the way on "conversation-list" is missing');
    if (!(await page.getByTestId("conversation-new").isVisible()))
      throw new Error('/chat/<unknown>: the way on "conversation-new" is missing');
    await capture("chat-missing");
  } finally {
    await page.unroute(detail, missing);
  }
}

async function listReachable(page) {
  return (
    (await page.getByTestId("conversation-list").isVisible()) ||
    (await page.getByTestId("conversation-list-trigger").isVisible())
  );
}
