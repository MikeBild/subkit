import { LOCALE_TAGS, translate } from "../../apps/cockpit/src/lib/i18n.ts";

function require(condition, message) {
  if (!condition) throw new Error(message);
}

async function contains(locator, text) {
  await locator.filter({ hasText: text }).waitFor({ state: "visible" });
}

export async function verifyKnowledgeHistoryProposalsEvidence(
  page,
  stand,
  locale,
  capture,
  { mockApi, recordId },
) {
  const t = (key) => translate(locale, key);
  const historyPath = `/v1/knowledge-sources/${recordId}/history`;
  const note = "Clarified operator escalation.";
  const versions = [
    {
      version: 2,
      content_hash: "b".repeat(64),
      author: { kind: "user", id: recordId },
      note,
      created_at: "2025-07-11T12:00:00.000Z",
      current: true,
    },
    {
      version: 1,
      content_hash: "a".repeat(64),
      author: null,
      note: "Initial instructions.",
      created_at: "2024-03-19T12:00:00.000Z",
      current: false,
    },
  ];
  const candidateIds = [
    "0a738614-5c4f-4a53-8a01-000000000051",
    "0a738614-5c4f-4a53-8a01-000000000052",
  ];
  const decided = new Set();
  const candidates = new Map();
  const events = [];
  const pattern = "**/v1/**";
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === historyPath)
      return route.fulfill({ json: { items: versions, total: 2 } });
    if (
      request.method() === "GET" &&
      [historyPath + "/1", historyPath + "/2"].includes(url.pathname)
    ) {
      const version = Number(url.pathname.split("/").at(-1));
      events.push({ method: "GET", version });
      return route.fulfill({
        json: {
          ...versions.find((item) => item.version === version),
          documents: [
            {
              path: "handbook.md",
              content:
                version === 2
                  ? "# Handbook\n\nContact the on-call operator."
                  : "# Handbook\n\nContact the support desk.",
            },
          ],
        },
      });
    }
    if (
      request.method() === "GET" &&
      url.pathname === "/v1/skill-candidates" &&
      !url.searchParams.has("knowledge_source_id")
    ) {
      return mockApi({
        request: () => request,
        fulfill: async (response) => {
          const body = JSON.parse(response.body);
          const original = body.items.find(
            (item) => item.reviewable && item.pattern_kind === "repair_pattern",
          );
          require(original, "Canonical reviewable repair proposal required");
          const items = candidateIds
            .filter((id) => !decided.has(id))
            .map((id) => ({
              ...original,
              id,
              title:
                id === candidateIds[0] ? "Inline accepted guidance" : "Inline discarded guidance",
              review_digest: id === candidateIds[0] ? "c".repeat(64) : "d".repeat(64),
            }));
          for (const item of items) candidates.set(item.id, item);
          events.push({ method: "GET", ids: items.map((item) => item.id) });
          return route.fulfill({
            ...response,
            body: JSON.stringify({
              ...body,
              items,
              total: items.length,
              reviewable_total: items.length,
            }),
          });
        },
      });
    }
    const mutation = /^\/v1\/skill-candidates\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
    if (request.method() === "POST" && mutation && candidateIds.includes(mutation[1])) {
      const [, id, action] = mutation;
      const body = request.postDataJSON();
      require(!decided.has(id), "Proposal must be decided only once");
      if (action === "approve")
        require(id === candidateIds[0] &&
          body.expected_review_digest === "c".repeat(64) &&
          body.status === "active" &&
          Object.keys(body).length ===
            2, "Inline approval must bind the displayed digest and activation");
      else
        require(id === candidateIds[1] &&
          body.reason === t("skills.rejectReason") &&
          Object.keys(body).length === 1, "Inline rejection must send its explicit reason");
      decided.add(id);
      events.push({ method: "POST", id, action, body });
      return route.fulfill({
        json:
          action === "approve"
            ? {
                candidate: {
                  ...candidates.get(id),
                  status: "approved",
                  promoted_skill_id: recordId,
                },
                skill_id: recordId,
                knowledge: null,
              }
            : { rejected: true },
      });
    }
    return route.fallback();
  };
  await page.route(pattern, handler);
  try {
    await stand.visit(page, `knowledge/${recordId}`);
    await page.getByTestId("knowledge-versions-toggle").click();
    await page
      .getByTestId(/^knowledge-versions-(?:mobile-)?row-link-0$/)
      .filter({ visible: true })
      .click();
    const sheet = page.getByTestId("knowledge-version-sheet");
    await contains(sheet, "v2");
    const savedAt = await page.evaluate(
      ({ date, tag }) =>
        new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(date),
        ),
      { date: versions[0].created_at, tag: LOCALE_TAGS[locale] },
    );
    await contains(sheet, `operator@example.com · ${savedAt}`);
    await contains(page.getByTestId("knowledge-version-facts"), note);
    await contains(
      page.getByTestId("knowledge-version-diff").locator('[data-diff-line="added"]'),
      "Contact the on-call operator.",
    );
    await contains(
      page.getByTestId("knowledge-version-diff").locator('[data-diff-line="removed"]'),
      "Contact the support desk.",
    );
    require([1, 2].every((version) =>
      events.some((event) => event.method === "GET" && event.version === version),
    ), "Diff must read both actual retained versions");
    await capture("knowledge-version-note-diff");
    await page.getByTestId("knowledge-version-close").click();
    await sheet.waitFor({ state: "hidden" });
    await page
      .getByTestId(/^knowledge-versions-(?:mobile-)?row-link-1$/)
      .filter({ visible: true })
      .click();
    await contains(sheet, "v1");
    await contains(page.getByTestId("knowledge-version-facts"), t("runs.caller.unknown"));
    const olderAt = await page.evaluate(
      ({ date, tag }) =>
        new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(date),
        ),
      { date: versions[1].created_at, tag: LOCALE_TAGS[locale] },
    );
    await contains(sheet, `${t("runs.caller.unknown")} · ${olderAt}`);
    await capture("knowledge-version-undocumented-author");
    await page.getByTestId("knowledge-version-close").click();
    await sheet.waitFor({ state: "hidden" });
    await stand.visit(page, "skills");
    for (const [index, action] of ["approve", "reject"].entries()) {
      const id = candidateIds[index];
      const button = page
        .getByTestId(`skill-proposal-row-${action === "approve" ? "accept" : "reject"}-${id}`)
        .filter({ visible: true });
      await button.waitFor({ state: "visible" });
      require((await page.getByTestId("skill-proposal").count()) ===
        0, "Inline decision must not require the proposal sheet");
      const start = events.length;
      await button.click();
      if (action === "reject") {
        const confirm = page.getByTestId(`skill-proposal-row-reject-confirm-${id}`);
        await confirm.waitFor({ state: "visible" });
        require(events
          .slice(start)
          .every(
            (event) => event.method !== "POST",
          ), "Opening rejection confirmation must not decide");
        await capture("skill-inline-reject-confirm");
        await page.getByTestId(`skill-proposal-row-reject-confirm-${id}-confirm`).click();
        await confirm.waitFor({ state: "hidden" });
      }
      await button.waitFor({ state: "hidden" });
      const recent = events.slice(start);
      require(recent.filter((event) => event.method === "POST" && event.id === id).length ===
        1, "Inline decision must send exactly one mutation");
      require(recent.some(
        (event) => event.method === "GET" && event.ids && !event.ids.includes(id),
      ), "Inline decision must refetch the changed proposal list");
      await capture(`skill-inline-${action}-persisted`);
    }
  } finally {
    await page.unroute(pattern, handler);
  }
}
