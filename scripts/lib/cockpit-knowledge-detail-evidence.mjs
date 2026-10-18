import { LOCALE_TAGS, translate } from "../../apps/cockpit/src/lib/i18n.ts";
import { closeRecordSheet } from "./cockpit-record-sheet.mjs";

const READ_AT = "2024-03-19T12:00:00.000Z";
const UPDATED_AT = "2025-07-11T12:00:00.000Z";
const ADDRESS = "https://docs.example.test/handbook";
const REVISED_ADDRESS = "https://docs.example.test/revised-handbook";
const WORKFLOW_ID = "018f4b4a-6d33-7b3a-9c2d-00000000a731";
const WORKFLOW_NAME = "Escalation workflow";

function require(condition, message) {
  if (!condition) throw new Error(message);
}

async function contains(locator, text) {
  await locator.filter({ hasText: text }).waitFor({ state: "visible" });
  require((await locator.innerText()).includes(text), `Missing knowledge evidence: ${text}`);
}

export async function verifyKnowledgeDetailEvidence(
  page,
  stand,
  locale,
  capture,
  { mockApi, recordId },
) {
  const t = (key, values) => translate(locale, key, values);
  const endpoint = `/v1/knowledge-sources/${recordId}`;
  const pattern = "**/v1/**";
  const events = [];
  const workflowRequests = [];
  const proposalRequests = [];
  let withoutWorkflowRead = false;
  let address = ADDRESS;
  let source = null;
  let stripMode = "url";
  const content = "# Escalation\n\nCall the operator and record the outcome.";
  const chunks = [
    {
      ordinal: 0,
      title: "Escalation",
      path: "/escalation",
      content,
      byte_size: new TextEncoder().encode(content).length,
    },
    {
      ordinal: 1,
      title: "Checklist",
      path: "/checklist",
      content: "Review the operating checklist.",
      byte_size: 31,
    },
  ];
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/v1/cockpit/bootstrap" &&
      withoutWorkflowRead
    ) {
      return mockApi({
        request: () => request,
        fulfill: async (response) => {
          require((response.status ?? 200) === 200 &&
            typeof response.body === "string", "Bootstrap permission fixture must be readable");
          const body = JSON.parse(response.body);
          const permissions = body.permissions ?? [];
          require(permissions.includes(
            "workflow:read",
          ), "Bootstrap baseline must include workflow:read");
          body.permissions = permissions.filter((permission) => permission !== "workflow:read");
          await route.fulfill({ ...response, body: JSON.stringify(body) });
        },
      });
    }
    if (
      request.method() === "GET" &&
      (url.pathname === "/v1/workflows" || url.pathname.startsWith("/v1/workflows/"))
    ) {
      workflowRequests.push(url.pathname);
      if (url.pathname === `/v1/workflows/${WORKFLOW_ID}`)
        return route.fulfill({
          json: { id: WORKFLOW_ID, name: WORKFLOW_NAME, slug: "escalation-workflow" },
        });
    }
    if (request.method() === "GET" && url.pathname === `${endpoint}/chunks`)
      return route.fulfill({ json: { items: chunks, total: 2 } });
    if (request.method() === "GET" && url.pathname === "/v1/skill-candidates") {
      proposalRequests.push(Object.fromEntries(url.searchParams));
      return route.fulfill({
        json: { items: [], total: 0, reviewable_total: 0, next_cursor: null },
      });
    }
    if (request.method() === "GET" && url.pathname === `${endpoint}/history`)
      return route.fulfill({
        json: {
          items: [{ version: 4, current: true, created_at: "2024-03-19T12:00:00.000Z" }],
          total: 1,
        },
      });
    if (request.method() === "GET" && url.pathname === endpoint) {
      return mockApi({
        request: () => request,
        fulfill: async (response) => {
          const body = JSON.parse(response.body);
          require((response.status ?? 200) === 200 &&
            body.id === recordId, "Canonical knowledge detail identity required");
          source = {
            ...body,
            source_type: stripMode === "history" ? "inline" : "url",
            scope: "workflow",
            workflow_id: WORKFLOW_ID,
            source_uri: address,
            status: "active",
            chunk_count: 2,
            last_refreshed_at: READ_AT,
            updated_at: UPDATED_AT,
          };
          events.push({ method: "GET", address });
          return route.fulfill({ ...response, body: JSON.stringify(source) });
        },
      });
    }
    if (request.method() === "PATCH" && url.pathname === endpoint) {
      const body = request.postDataJSON();
      require(source &&
        Object.keys(body).join("|") === "source_uri", "Address edit must only patch source_uri");
      require(body.source_uri ===
        REVISED_ADDRESS, "Address edit must preserve the exact entered URL");
      address = body.source_uri;
      events.push({ method: "PATCH", address });
      return route.fulfill({ json: { ...source, source_uri: address } });
    }
    return route.fallback();
  };
  await page.route(pattern, handler);
  try {
    await stand.visit(page, `knowledge/${recordId}`);
    await contains(page.getByTestId("knowledge-facts"), t("knowledge.column.kind"));
    await contains(page.getByTestId("knowledge-facts"), t("knowledge.kind.url"));
    await contains(page.getByTestId("knowledge-facts"), ADDRESS);
    const workflowLink = page.getByTestId("knowledge-scope-workflow");
    await workflowLink.waitFor({ state: "visible" });
    require((await workflowLink.innerText()).trim() ===
      WORKFLOW_NAME, "Workflow usage must show the persisted workflow name");
    require(new URL(await workflowLink.getAttribute("href"), page.url()).pathname ===
      `/cockpit/workflows/${WORKFLOW_ID}`, "Workflow usage must link to the exact persisted workflow");
    require(workflowRequests.length === 1 &&
      workflowRequests[0] ===
        `/v1/workflows/${WORKFLOW_ID}`, "Workflow usage must fetch only the exact persisted workflow");
    await page
      .getByTestId(/^knowledge-sections-(?:mobile-)?row-link-0$/)
      .filter({ visible: true })
      .click();
    const sheet = page.getByTestId("knowledge-section-sheet");
    await contains(sheet, "Escalation");
    await contains(sheet, source.name);
    const facts = page.getByTestId("knowledge-section-facts");
    await contains(facts, t("knowledge.column.size"));
    await contains(facts, `${chunks[0].byte_size} B`);
    await contains(facts, t("knowledge.column.read"));
    const dates = await page.evaluate(
      ({ read, updated, tag }) => {
        const formatter = new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" });
        return {
          read: formatter.format(new Date(read)),
          updated: formatter.format(new Date(updated)),
        };
      },
      { read: READ_AT, updated: UPDATED_AT, tag: LOCALE_TAGS[locale] },
    );
    await contains(facts, dates.read);
    require(!(await facts.innerText()).includes(
      dates.updated,
    ), "Read timestamp must not use source updated_at");
    await contains(sheet, "Call the operator and record the outcome.");
    await capture("knowledge-section-recorded-facts");
    await closeRecordSheet(sheet);
    if (!(await page.getByTestId("knowledge-edit").isVisible()))
      await page.getByTestId("detail-menu").click();
    await page.getByTestId("knowledge-edit").click();
    const dialog = page.getByTestId("knowledge-edit-dialog");
    await dialog.waitFor({ state: "visible" });
    require((await page.getByTestId("knowledge-edit-address").inputValue()) ===
      ADDRESS, "Address editor must load the stored URL");
    await page.getByTestId("knowledge-edit-address").fill(REVISED_ADDRESS);
    const start = events.length;
    await dialog.getByRole("button", { name: t("common.save"), exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await contains(page.getByTestId("knowledge-facts"), REVISED_ADDRESS);
    const recent = events.slice(start);
    require(recent.filter((event) => event.method === "PATCH").length ===
      1, "Address edit must send exactly one PATCH");
    require(recent[0]?.method === "PATCH" &&
      recent
        .slice(1)
        .some(
          (event) => event.method === "GET" && event.address === REVISED_ADDRESS,
        ), "Address edit must refetch the persisted URL");
    await capture("knowledge-address-saved");
    await stand.visit(page, `knowledge/${recordId}`);
    await contains(page.getByTestId("knowledge-facts"), REVISED_ADDRESS);
    withoutWorkflowRead = true;
    const requestsBeforeRestrictedVisit = workflowRequests.length;
    await stand.visit(page, `knowledge/${recordId}`);
    const restrictedFacts = page.getByTestId("knowledge-facts");
    await contains(restrictedFacts, REVISED_ADDRESS);
    require((await page.getByTestId("knowledge-scope-workflow").count()) ===
      0, "A person without workflow:read must not see a workflow usage claim");
    require(!(await restrictedFacts.innerText()).includes(
      t("knowledge.field.scope"),
    ), "A person without workflow:read must not see an unlabeled workflow usage claim");
    require(workflowRequests.length ===
      requestsBeforeRestrictedVisit, "A person without workflow:read must not trigger a workflow request");
    withoutWorkflowRead = false;
    require(proposalRequests.length ===
      0, `Knowledge detail must not load skill proposals; requests=${JSON.stringify(proposalRequests)}`);
    require((await page.getByTestId("knowledge-review-proposal").count()) ===
      0, "Knowledge detail must not offer a learning proposal review");
    stripMode = "history";
    await page.reload();
    const changedWhen = await page.evaluate(
      ({ value, tag }) =>
        new Intl.DateTimeFormat(tag, { dateStyle: "medium" }).format(new Date(value)),
      { value: "2024-03-19T12:00:00.000Z", tag: LOCALE_TAGS[locale] },
    );
    const expectedHistoryLine = t("knowledge.strip.version", {
      version: 4,
      when: changedWhen,
    });
    const historyLine = page
      .getByTestId("knowledge-strip")
      .locator('[data-slot="status-strip-line"]');
    await historyLine.filter({ hasText: expectedHistoryLine }).waitFor({ state: "visible" });
    require((await historyLine.innerText()).trim() ===
      expectedHistoryLine, "Inline source strip must show the current saved version and its creation time, not refresh time");
    await capture("knowledge-history-status-strip");
  } finally {
    await page.unroute(pattern, handler);
  }
}
