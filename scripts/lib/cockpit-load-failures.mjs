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
    if (!(await page.getByTestId("chat-load-failed-new").isVisible()))
      throw new Error("/chat/<id>: a conversation that cannot be opened offers no way on");
    if (!(await page.getByTestId("chat-load-failed-list").isVisible()))
      throw new Error("/chat/<id>: a conversation that cannot be opened offers no way to the list");
    // The header must not call a failed conversation a new one.
    const title = (await page.getByTestId("chat-title").innerText()).trim();
    if (title === "Neue Unterhaltung" || title === "New conversation")
      throw new Error("/chat/<id>: the header titles a failed conversation as a new one");
    await capture("chat");
  } finally {
    await page.unroute(detail, refuse);
  }
}
