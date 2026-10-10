import { LOCALE_TAGS, translate } from "../../apps/cockpit/src/lib/i18n.ts";
import { closeRecordSheet } from "./cockpit-record-sheet.mjs";

const READ_AT = "2024-03-19T12:00:00.000Z";
const UPDATED_AT = "2025-07-11T12:00:00.000Z";
const ADDRESS = "https://docs.example.test/handbook";
const REVISED_ADDRESS = "https://docs.example.test/revised-handbook";

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
  const t = (key) => translate(locale, key);
  const endpoint = `/v1/knowledge-sources/${recordId}`;
  const pattern = "**/v1/**";
  const events = [];
  let address = ADDRESS;
  let source = null;
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
    if (request.method() === "GET" && url.pathname === `${endpoint}/chunks`)
      return route.fulfill({ json: { items: chunks, total: 2 } });
    if (request.method() === "GET" && url.pathname === endpoint) {
      return mockApi({
        request: () => request,
        fulfill: async (response) => {
          const body = JSON.parse(response.body);
          require((response.status ?? 200) === 200 &&
            body.id === recordId, "Canonical knowledge detail identity required");
          source = {
            ...body,
            source_type: "url",
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
  } finally {
    await page.unroute(pattern, handler);
  }
}
