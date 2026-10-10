import { LOCALE_TAGS, translate } from "../../apps/cockpit/src/lib/i18n.ts";

function require(condition, message) {
  if (!condition) throw new Error(message);
}

async function exact(locator, value) {
  await locator.getByText(value, { exact: true }).waitFor({ state: "visible" });
}

export async function verifyWorkflowHistoryEvidence(
  page,
  stand,
  locale,
  capture,
  { mockApi, recordId },
) {
  const t = (key) => translate(locale, key);
  const actorId = "01900000-0000-4000-8000-000000000071";
  const email = "workflow-author@example.test";
  const account = "Workflow publishing account";
  const checksum = "09af".repeat(16);
  const history = [
    {
      id: "01900000-0000-4000-8000-000000000083",
      version: 3,
      author: { kind: "user", id: actorId },
      created_at: "2025-07-11T12:00:00.000Z",
    },
    {
      id: "01900000-0000-4000-8000-000000000082",
      version: 2,
      author: null,
      created_at: "2025-07-10T12:00:00.000Z",
    },
    {
      id: "01900000-0000-4000-8000-000000000081",
      version: 1,
      author: { kind: "system_account", id: actorId },
      created_at: "2025-07-09T12:00:00.000Z",
    },
  ].map((row) => ({
    ...row,
    workflow_id: recordId,
    invalid: false,
    note: `Saved content ${row.version}`,
    checksum: row.version === 3 ? checksum : String(row.version).repeat(64),
  }));
  let undocumented = false;
  let definition;
  const writes = [];
  const pattern = "**/v1/**";
  const transform = (route, change) =>
    mockApi({
      request: () => route.request(),
      fulfill: (response) =>
        route.fulfill({ ...response, body: JSON.stringify(change(JSON.parse(response.body))) }),
    });
  const handler = async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && path.startsWith(`/v1/workflows/${recordId}`)) {
      writes.push({ method: request.method(), path });
      return route.fulfill({
        status: 409,
        json: { error: { code: "unexpected_evidence_mutation" } },
      });
    }
    if (request.method() !== "GET") return route.fallback();
    if (path === `/v1/workflows/${recordId}/history`) {
      require(undocumented ||
        definition, "Canonical workflow definition must precede history rendering");
      const items = undocumented
        ? []
        : history.map((row) => ({ ...row, dag: structuredClone(definition) }));
      return route.fulfill({ json: { items, total: items.length } });
    }
    if (path === `/v1/workflows/${recordId}`)
      return transform(route, (body) => {
        require(typeof body.name === "string" &&
          Array.isArray(body.steps), "Canonical workflow definition required");
        definition = {
          name: body.name,
          steps: structuredClone(body.steps),
          ...(body.input_schema ? { input_schema: body.input_schema } : {}),
          ...(body.output_schema ? { output_schema: body.output_schema } : {}),
        };
        return {
          ...body,
          created_at: history[2].created_at,
          current_version: undocumented ? null : 3,
          current_version_id: undocumented ? null : history[0].id,
          draft_version_id: null,
          ...(undocumented ? { lifecycle: "draft", steps: [] } : {}),
          creator: undocumented ? null : history[2].author,
          checksum: undocumented ? null : history[0].checksum,
        };
      });
    if (path === "/v1/identity/users")
      return transform(route, (body) => ({
        ...body,
        items: [{ ...body.items[0], id: actorId, email }],
        total: 1,
      }));
    if (path === "/v1/identity/system-accounts")
      return transform(route, (body) => ({
        ...body,
        items: [{ ...body.items[0], id: actorId, name: account }],
        total: 1,
      }));
    return route.fallback();
  };
  await page.route(pattern, handler);
  try {
    await stand.visit(page, `workflows/${recordId}`);
    await page.getByTestId("workflow-tabs-tab-structure").click();
    await page.getByTestId("workflow-versions-toggle").click();
    const labels = [email, t("runs.caller.unknown"), account];
    for (const [index, version] of history.entries()) {
      const row = page
        .locator(
          `[data-testid="workflow-versions-row-${index}"], [data-testid="workflow-versions-mobile-row-${index}"]`,
        )
        .filter({ visible: true });
      const date = await page.evaluate(
        ({ tag, at }) =>
          new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }).format(
            new Date(at),
          ),
        { tag: LOCALE_TAGS[locale], at: version.created_at },
      );
      const saved = `${labels[index]} · ${date}`;
      await exact(row, saved);
      require(!(await row.innerText()).includes(
        actorId,
      ), "Version list exposes a raw actor identifier");
      await row.getByRole("button", { name: `v${version.version}`, exact: true }).click();
      const sheet = page.getByTestId("workflow-version-sheet");
      await exact(sheet.getByTestId("workflow-version-facts"), saved);
      require(!(await sheet.innerText()).includes(
        actorId,
      ), "Version sheet exposes a raw actor identifier");
      await capture(`workflow-version-author-${version.version}`);
      await page.getByTestId("workflow-version-sheet-close").click();
      await sheet.waitFor({ state: "hidden" });
    }
    await page.getByTestId("workflow-technical-toggle").click();
    await exact(page.getByTestId("workflow-technical-checksum").locator("dd"), checksum);
    await exact(page.getByTestId("workflow-technical-creator").locator("dd"), account);
    require((await page.getByTestId("workflow-technical-creator").innerText()).includes(email) ===
      false, "Creator was incorrectly taken from the latest version author");
    await capture("workflow-technical-known-creator-checksum");
    undocumented = true;
    await stand.visit(page, `workflows/${recordId}`);
    await page.getByTestId("workflow-tabs-tab-structure").click();
    await page.getByTestId("workflow-technical-toggle").click();
    await exact(page.getByTestId("workflow-technical-checksum").locator("dd"), "—");
    await exact(
      page.getByTestId("workflow-technical-creator").locator("dd"),
      t("runs.caller.unknown"),
    );
    await capture("workflow-technical-undocumented-creator-checksum");
    require(writes.length === 0, "Read-only version evidence attempted a workflow mutation");
  } finally {
    await page.unroute(pattern, handler);
  }
}
