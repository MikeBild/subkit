export async function verifyKnowledgeTotals(page, stand, locale, capture) {
  const de = locale === "de";
  const rows = Array.from({ length: 83 }, (_, index) => ({
    id: `knowledge-total-${index}`,
    name: `Handbook ${index + 1}`,
    slug: `handbook-${index + 1}`,
    description: "Operating instructions",
    description_source: index % 2 === 1 ? "llm" : "human",
    category: "other",
    category_source: "human",
    status: "active",
    scope: "global",
    workflow_id: null,
    source_type: "file_upload",
    chunk_count: index + 1,
    bytes_total: 18400,
    updated_at: "2026-08-10T08:00:00.000Z",
  }));
  const requests = [];
  const pattern = /\/v1\/knowledge-sources(?:\?.*)?$/;
  const handler = async (route) => {
    const url = new URL(route.request().url());
    const origin = url.searchParams.get("description_source");
    const filtered = rows.filter((row) => !origin || row.description_source === origin);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const items = filtered.slice(offset, offset + limit);
    requests.push({ origin, offset, returned: items.length });
    return route.fulfill({
      json: {
        items,
        total: filtered.length,
        sections_total: filtered.reduce((sum, row) => sum + row.chunk_count, 0),
      },
    });
  };
  const expectSummary = async (sources, sections) => {
    const expected = de
      ? `${sources} Quellen · ${sections} Abschnitte`
      : `${sources} sources · ${sections} sections`;
    await page.waitForFunction(
      (text) =>
        document.querySelector('[data-testid="knowledge-summary"]')?.textContent?.includes(text),
      expected,
    );
  };
  await page.route(pattern, handler);
  try {
    await stand.visit(page, "knowledge");
    await expectSummary(83, 3486);
    if (
      !requests.some(
        (request) => request.origin === null && request.offset === 0 && request.returned === 50,
      )
    )
      throw new Error("knowledge totals fixture did not exercise a partial first page");
    await capture("all-pages-total");
    await page
      .getByTestId("catalog-origin")
      .getByRole("radio", { name: de ? "Von KI" : "By AI", exact: true })
      .click();
    await expectSummary(41, 1722);
    if (!requests.some((request) => request.origin === "llm" && request.offset === 0))
      throw new Error("knowledge origin filter did not reach the API");
    await capture("filtered-total");
    await page
      .getByTestId("catalog-origin")
      .getByRole("radio", { name: de ? "Alle" : "All", exact: true })
      .click();
    await expectSummary(83, 3486);
  } finally {
    await page.unroute(pattern, handler);
  }
}
