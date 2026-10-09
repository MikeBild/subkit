import { translate } from "../../apps/cockpit/src/lib/i18n.ts";

const ROUTE = "**/v1/**";
const ORIGINAL = "Summarizes the approved operating instructions.";
const UPDATED = "Summarizes the revised operating instructions and escalation steps.";
const SURFACES = [
  {
    kind: "workflow",
    page: "workflows",
    api: "workflows",
    menu: "workflow-menu",
    metadataSuffix: "/metadata",
  },
  {
    kind: "connector",
    page: "connectors",
    api: "connectors",
    menu: "connector-menu",
    metadataSuffix: "",
  },
  {
    kind: "knowledge_source",
    page: "knowledge",
    api: "knowledge-sources",
    menu: "detail-menu",
    metadataSuffix: "",
  },
  { kind: "skill", page: "skills", api: "skills", menu: "detail-menu", metadataSuffix: "" },
  { kind: "file", page: "files", api: "files", menu: "file-menu", metadataSuffix: "" },
];

function require(condition, message) {
  if (!condition) throw new Error(message);
}

async function contains(locator, expected, context) {
  await locator.filter({ hasText: expected }).waitFor({ state: "visible" });
  require((await locator.innerText()).includes(expected), `${context}: missing ${expected}`);
}

export async function verifyDescriptionEvidence(
  page,
  stand,
  locale,
  capture,
  { mockApi, recordId },
) {
  require(typeof recordId === "string", "Description fixtures need the canonical record ID");
  const t = (key) => translate(locale, key);
  const records = new Map(
    SURFACES.map((surface) => [
      surface.kind,
      {
        ...surface,
        detailPath: `/v1/${surface.api}/${recordId}`,
        patchPath: `/v1/${surface.api}/${recordId}${surface.metadataSuffix}`,
        description: ORIGINAL,
        source: "llm",
        base: null,
        concurrentDescription: null,
      },
    ]),
  );
  const events = [];
  const handler = async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const detail = [...records.values()].find((record) => record.detailPath === path);
    if (request.method() === "GET" && detail) {
      return mockApi({
        request: () => request,
        fulfill: async (response) => {
          require((response.status ?? 200) === 200 &&
            typeof response.body ===
              "string", "Description fixture requires a successful canonical detail response");
          const body = JSON.parse(response.body);
          require(body.id ===
            recordId, "Description detail fixture must preserve its record identity");
          detail.base = body;
          const projected = {
            ...body,
            description: detail.description,
            description_source: detail.source,
          };
          events.push({
            kind: detail.kind,
            method: "GET",
            description: projected.description,
            source: projected.description_source,
          });
          await route.fulfill({ ...response, body: JSON.stringify(projected) });
        },
      });
    }
    const mutation = [...records.values()].find((record) => record.patchPath === path);
    if (request.method() === "PATCH" && mutation) {
      const body = request.postDataJSON();
      require(body &&
        typeof body === "object" &&
        !Array.isArray(body), "Description acceptance must send a JSON object");
      require(Object.keys(body).sort().join("|") ===
        "accept_description|description", "Description acceptance must not write category or unrelated metadata");
      require(body.accept_description === true &&
        typeof body.description === "string" &&
        body.description.trim().length >
          0, "Description acceptance requires its exact nonempty text and explicit acceptance flag");
      require(mutation.base, "Description acceptance must follow a loaded record");
      if (mutation.concurrentDescription !== null) {
        mutation.description = mutation.concurrentDescription;
        mutation.concurrentDescription = null;
      }
      if (body.description !== mutation.description) {
        events.push({
          kind: mutation.kind,
          method: "PATCH",
          body,
          status: 409,
          description: mutation.description,
          source: mutation.source,
        });
        return route.fulfill({
          status: 409,
          json: {
            code: "description_changed",
            message: "The description changed; read it again before accepting it.",
            trace_id: "description-evidence-conflict",
          },
        });
      }
      mutation.source = "human";
      const result = {
        ...mutation.base,
        description: mutation.description,
        description_source: mutation.source,
      };
      events.push({
        kind: mutation.kind,
        method: "PATCH",
        body,
        status: 200,
        description: result.description,
        source: result.description_source,
      });
      return route.fulfill({ status: 200, json: result });
    }
    return route.fallback();
  };

  async function openMenu(record, expectedAccept) {
    const trigger = page.getByTestId(record.menu);
    if (!expectedAccept && (await trigger.count()) === 0) {
      await contains(
        page.getByTestId("catalog-metadata-edit"),
        t("catalogMeta.dialogTitle"),
        "single metadata edit action",
      );
      require((await page.getByTestId("catalog-metadata-accept").count()) ===
        0, "Human description must not offer AI acceptance");
      return;
    }
    await trigger.waitFor({ state: "visible" });
    if ((await trigger.getAttribute("aria-expanded")) === "true")
      await page.keyboard.press("Escape");
    await trigger.and(page.locator('[aria-expanded="false"]')).waitFor({ state: "visible" });
    await page.getByTestId("catalog-metadata-edit").waitFor({ state: "hidden" });
    await trigger.click();
    await trigger
      .and(page.locator('[aria-expanded="true"][data-state="open"]'))
      .waitFor({ state: "visible" });
    await contains(
      page.getByTestId("catalog-metadata-edit"),
      t("catalogMeta.dialogTitle"),
      "metadata menu edit action",
    );
    if (expectedAccept) {
      await contains(
        page.getByTestId("catalog-metadata-accept"),
        t("catalogMeta.accept"),
        "explicit AI acceptance action",
      );
    } else {
      require((await page.getByTestId("catalog-metadata-accept").count()) ===
        0, "Human description must not offer AI acceptance");
    }
  }

  async function accept(record, expectedStatus) {
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === record.patchPath &&
        response.request().method() === "PATCH",
    );
    await page.getByTestId("catalog-metadata-accept").click();
    const response = await responsePromise;
    require(response.status() ===
      expectedStatus, `Description acceptance returned ${response.status()} instead of ${expectedStatus}`);
    return response.json();
  }

  async function verifyAccepted(record, expected, since, phase) {
    await page.getByTestId("catalog-metadata-by-assistant").waitFor({ state: "hidden" });
    await contains(
      page.getByTestId("catalog-metadata-description"),
      expected,
      "accepted description text",
    );
    const recent = events.slice(since).filter((event) => event.kind === record.kind);
    const write = recent.findIndex((event) => event.method === "PATCH" && event.status === 200);
    require(write >= 0 &&
      recent
        .slice(write + 1)
        .some(
          (event) =>
            event.method === "GET" && event.description === expected && event.source === "human",
        ), "Successful acceptance must refetch the persisted human description");
    require(record.description === expected &&
      record.source === "human", "Acceptance must preserve the exact stored description");
    await openMenu(record, false);
    await capture(`description-${record.kind}-${phase}-accepted-menu`);
    if ((await page.getByTestId(record.menu).count()) === 0) return;
    await page.keyboard.press("Escape");
    await page
      .getByTestId(record.menu)
      .and(page.locator('[aria-expanded="false"][data-state="closed"]'))
      .waitFor({ state: "visible" });
    await page.getByTestId("catalog-metadata-edit").waitFor({ state: "hidden" });
  }

  await page.route(ROUTE, handler);
  try {
    for (const record of records.values()) {
      await stand.visit(page, `${record.page}/${recordId}`);
      await contains(
        page.getByTestId("catalog-metadata-description"),
        ORIGINAL,
        "initial AI description",
      );
      await page.getByTestId("catalog-metadata-by-assistant").waitFor({ state: "visible" });
      await openMenu(record, true);
      await capture(`description-${record.kind}-ai-menu`);
      const before = events.length;
      const category = record.base.category;
      const categorySource = record.base.category_source;
      const accepted = await accept(record, 200);
      require(accepted.description === ORIGINAL &&
        accepted.description_source ===
          "human", "Successful PATCH must return the unchanged description as human");
      require(accepted.category === category &&
        accepted.category_source ===
          categorySource, "Accepting a description must preserve category provenance");
      await verifyAccepted(record, ORIGINAL, before, "initial");

      record.description = ORIGINAL;
      record.source = "llm";
      await stand.visit(page, `${record.page}/${recordId}`);
      await contains(
        page.getByTestId("catalog-metadata-description"),
        ORIGINAL,
        "loaded text before concurrent edit",
      );
      await page.getByTestId("catalog-metadata-by-assistant").waitFor({ state: "visible" });
      await openMenu(record, true);
      record.concurrentDescription = UPDATED;
      const beforeConflict = events.length;
      const conflict = await accept(record, 409);
      require(conflict.code ===
        "description_changed", "Stale text must preserve the public conflict code");
      await contains(
        page
          .locator("[data-sonner-toast]")
          .filter({ hasText: t("detail.saveFailed") })
          .last(),
        t("detail.saveFailed"),
        "stale acceptance error",
      );
      require(record.description === UPDATED &&
        record.source ===
          "llm", "Stale acceptance must not overwrite the newer description or accept it");
      const stale = events
        .slice(beforeConflict)
        .filter((event) => event.kind === record.kind && event.method === "PATCH");
      require(stale.length === 1 &&
        stale[0].body.description === ORIGINAL &&
        stale[0].status ===
          409, "Stale acceptance must send the displayed original text exactly once");
      await page.getByTestId("catalog-metadata-by-assistant").waitFor({ state: "visible" });
      await capture(`description-${record.kind}-stale-conflict`);

      await stand.visit(page, `${record.page}/${recordId}`);
      await contains(
        page.getByTestId("catalog-metadata-description"),
        UPDATED,
        "reloaded concurrent description",
      );
      await openMenu(record, true);
      const retry = events.length;
      const refreshed = await accept(record, 200);
      require(refreshed.description === UPDATED &&
        refreshed.description_source ===
          "human", "Renewed acceptance must apply only to the reloaded text");
      await verifyAccepted(record, UPDATED, retry, "reloaded");
    }
  } finally {
    await page.unroute(ROUTE, handler);
  }
}
