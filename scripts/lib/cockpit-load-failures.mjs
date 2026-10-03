// A read that fails must look like a failure.
//
// Several pages asked only "still loading?" and then rendered rows. A failed
// read has no rows either, so it fell through to the empty state: the people
// page said nobody was a member, the settings page showed an installation
// with nothing configured, and a conversation that could not be opened turned
// into the empty new-chat screen with a composer that would have posted into
// the conversation that had just failed.
//
// Every other fixture in this sweep answers. This one refuses — 500 on the
// three reads — and asserts the page names the failure (`*-load-failed`) and
// does NOT show the state it used to fall through to. A sweep whose fixtures
// always succeed cannot see this class at all.

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

/** Matches the path exactly, whatever the query — `?limit=200` defeats a plain glob. */
const exactPath = (path) => (url) => new URL(url).pathname === path;

const refuse = (route) =>
  route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "internal", message: "fixture refuses this read" } }),
  });

async function expectFailure(page, where, failed, notShown) {
  // React Query retries a failed read before giving up; the page must say so
  // after the first failure, well inside this bound.
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

  // A conversation that cannot be opened: an error with a way back, not the
  // new-chat screen and not a composer aimed at the id that just failed.
  const detail = exactPath(`/v1/conversations/${conversation.id}`);
  await page.route(detail, refuse);
  try {
    await stand.visit(page, `chat/${conversation.id}`);
    await expectFailure(page, "/chat/<id>", "chat-load-failed", [
      "chat-empty",
      "chat-composer-area",
    ]);
    // The ways on stand once, in the page header — not a second time in the
    // failure line.
    if (!(await page.getByTestId("conversation-new").isVisible()))
      throw new Error("/chat/<id>: a conversation that cannot be opened offers no way on");
    if (!(await listReachable(page)))
      throw new Error("/chat/<id>: a conversation that cannot be opened offers no way to the list");
    // The conversation's head must not call a failed conversation a new one.
    const title = (await page.getByTestId("chat-title").innerText()).trim();
    if (title === "Neue Unterhaltung" || title === "New conversation")
      throw new Error("/chat/<id>: the header titles a failed conversation as a new one");
    await capture("chat");
  } finally {
    await page.unroute(detail, refuse);
  }

  // Unknown or not the reader's: said as that, with the list and a new
  // conversation — and no retry, which used to be offered with "reload the
  // page or try again in a moment", advice that could never work.
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

/** The conversation list is in reach: beside the page, or one toggle away on a phone. */
async function listReachable(page) {
  return (
    (await page.getByTestId("conversation-list").isVisible()) ||
    (await page.getByTestId("conversation-list-trigger").isVisible())
  );
}
