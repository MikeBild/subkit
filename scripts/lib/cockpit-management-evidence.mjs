import { formatDateTime, LOCALE_TAGS, translate } from "../../apps/cockpit/src/lib/i18n.ts";
import { windowFilterLabel } from "../../apps/cockpit/src/lib/window-filter.ts";
import { verifyPeopleLoadsPerTab } from "./cockpit-people-tabs.mjs";
import { closeRecordSheet } from "./cockpit-record-sheet.mjs";

const ACTOR_ID = "8b18c6a4-00e7-4c3b-b044-2a04d6915842";
const GROUP_ID = "15683d9a-42c7-49d8-9549-40a19eb15f44";
const DELETED_ID = "56bef7bf-6cc6-4949-9551-981048fd04c5";
const UNKNOWN_ID = "3e9e99fc-c279-4a42-9c2b-b2e9a0b7c80f";
const EMAIL = "management-reader@example.test";
const SERVICE = "Management automation";
const GROUP = "Evidence reviewers";
const DELETED_NAME = "Archived reconciliation";
const DELETED_TRACE_ID = "6a8f2c14-1b73-4d9e-8f20-5c7a91e3b642";
const USED_AT = "2024-01-17T12:00:00.000Z";
const ROUTE = "**/v1/**";

function require(condition, message) {
  if (!condition) throw new Error(message);
}

async function contains(locator, value, label) {
  await locator.filter({ hasText: value }).waitFor({ state: "visible" });
  require((await locator.innerText()).includes(value), `${label}: missing ${value}`);
}

async function excludes(locator, values, label) {
  const text = await locator.innerText();
  for (const value of values) require(!text.includes(value), `${label}: exposed ${value}`);
}

function row(page, table, index) {
  return page
    .locator(`[data-testid="${table}-row-${index}"], [data-testid="${table}-mobile-row-${index}"]`)
    .filter({ visible: true });
}

async function openRow(page, table, index) {
  await page
    .locator(
      `[data-testid="${table}-row-link-${index}"], [data-testid="${table}-mobile-row-link-${index}"]`,
    )
    .filter({ visible: true })
    .click();
}

function fact(page, table, label) {
  return page
    .getByTestId(table)
    .locator(":scope > div")
    .filter({
      has: page.getByText(label, { exact: true }),
    })
    .locator("dd");
}

async function transform(route, mockApi, change) {
  await mockApi({
    request: () => route.request(),
    fulfill: async (response) => {
      require((response.status ?? 200) === 200 &&
        typeof response.body ===
          "string", "Management fixture requires a successful canonical JSON response");
      await route.fulfill({ ...response, body: JSON.stringify(change(JSON.parse(response.body))) });
    },
  });
}

export async function verifyManagementEvidence(
  page,
  stand,
  locale,
  capture,
  { mockApi, tenantId },
) {
  require(typeof tenantId === "string", "Management fixture requires the canonical tenant ID");
  const timestamps = {
    tenant_id: tenantId,
    created_at: "2024-01-01T12:00:00.000Z",
    updated_at: "2024-01-01T12:00:00.000Z",
  };
  const auditWindowStartedAt = Date.now();
  const auditTimestamp = (daysAgo) =>
    new Date(auditWindowStartedAt - daysAgo * 86_400_000).toISOString();
  const customFrom = auditTimestamp(10);
  const customTo = auditTimestamp(0);
  const t = (key) => translate(locale, key);
  const translateWithValues = (key, values) => translate(locale, key, values);
  const formatDate = (value) => formatDateTime(locale, value);
  let entries = [];
  const auditWrites = [];
  const auditRequests = [];
  const auditRequestListener = (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/v1/audit-log") auditRequests.push(url);
    if (url.pathname.startsWith("/v1/") && request.method() !== "GET")
      auditWrites.push({ method: request.method(), path: url.pathname });
  };
  const handler = async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/identity/users")
      return transform(route, mockApi, (body) => ({
        ...body,
        items: [
          {
            ...body.items[0],
            ...timestamps,
            oauth_connections: 0,
            id: ACTOR_ID,
            email: EMAIL,
            role: "member",
            status: "active",
            groups: [{ id: GROUP_ID, name: GROUP }],
          },
          ...body.items.map((user) => ({
            ...timestamps,
            oauth_connections: 0,
            groups: [],
            ...user,
          })),
        ],
        total: body.items.length + 1,
      }));
    if (path === "/v1/identity/system-accounts")
      return transform(route, mockApi, (body) => ({
        ...body,
        items: [
          { ...body.items[0], ...timestamps, id: ACTOR_ID, name: SERVICE },
          ...body.items.map((account) => ({ ...timestamps, ...account })),
        ],
      }));
    if (path === "/v1/rbac/roles")
      return transform(route, mockApi, (body) => {
        require(body.items.length >= 3, "Role evidence requires three canonical role records");
        return {
          ...body,
          items: [
            {
              ...body.items[0],
              name: "Evidence pair",
              permissions: ["workflow:read", "workflow:run"],
              member_count: 7,
            },
            {
              ...body.items[1],
              name: "Evidence expanded",
              permissions: [
                "workflow:read",
                "workflow:run",
                "connector:read",
                "knowledge:read",
                "file:read",
              ],
              member_count: 19,
            },
            { ...body.items[2], name: "Evidence empty", permissions: [], member_count: 0 },
          ],
          total: 3,
        };
      });
    if (path === "/v1/rbac/groups")
      return transform(route, mockApi, (body) => ({
        ...body,
        items: [
          {
            ...body.items[0],
            ...timestamps,
            id: GROUP_ID,
            name: GROUP,
            member_count: 1,
            member_ids: [ACTOR_ID],
          },
          ...body.items.map((group) => ({
            ...timestamps,
            member_count: 0,
            member_ids: [],
            ...group,
          })),
        ],
      }));
    if (path === "/v1/rbac/grants")
      return transform(route, mockApi, (body) => {
        require(body.items.length > 0, "Management fixture requires a grant base row");
        const base = body.items[0];
        return {
          ...body,
          items: [
            {
              ...base,
              id: "e78b1d88-307d-4407-bbb6-a84ea115db79",
              resource_type: "workflow",
              expires_at: null,
            },
            {
              ...base,
              id: "c57b38d7-4724-4bc5-9b95-ec5c4e7238fe",
              resource_type: "workflow",
              expires_at: null,
            },
            {
              ...base,
              id: "ce65126b-c819-4ce6-bab6-c9e87d7ee40f",
              resource_type: "workflow",
              expires_at: null,
            },
          ],
          total: 3,
        };
      });
    if (path === "/v1/audit-log")
      return transform(route, mockApi, (body) => {
        require(body.items.length > 0, "Management fixture requires an audit base row");
        const requestUrl = new URL(route.request().url());
        if (requestUrl.searchParams.has("ts_to")) {
          require(requestUrl.searchParams.get("ts_from") === customFrom &&
            requestUrl.searchParams.get("ts_to") ===
              customTo, "Custom audit query must preserve the linked time range");
        } else {
          const expectedFrom = auditWindowStartedAt - 30 * 86_400_000;
          require(Math.abs(
            Date.parse(requestUrl.searchParams.get("ts_from") ?? "") - expectedFrom,
          ) < 10_000, "Default audit query must request the rolling thirty-day window");
        }
        entries = [
          {
            ...body.items[0],
            ts: auditTimestamp(1),
            id: "ef95c40f-acf2-474c-a19f-f909d36d5d8c",
            actor_type: "user",
            actor_id: ACTOR_ID,
            action: "workflow.deleted",
            resource_type: "workflow",
            resource_id: DELETED_ID,
            resource_name: DELETED_NAME,
            trace_id: DELETED_TRACE_ID,
            result: "success",
            reason: null,
            before: null,
            after: null,
            metadata: {},
          },
          {
            ...body.items[0],
            ts: auditTimestamp(2),
            id: "b06359bf-a046-41ea-8765-b3b081b92a26",
            actor_type: "system_account",
            actor_id: ACTOR_ID,
            action: "workflow.deleted",
            resource_type: "workflow",
            resource_id: UNKNOWN_ID,
            resource_name: null,
            trace_id: null,
            result: "success",
            reason: null,
            before: null,
            after: null,
            metadata: {},
          },
        ];
        const resourceTypes = requestUrl.searchParams.get("resource_types")?.split(",") ?? [];
        const visibleEntries = resourceTypes.length
          ? resourceTypes.includes("connector")
            ? [
                {
                  ...body.items[0],
                  ts: auditTimestamp(1),
                  id: "fa9e3912-6ef1-4436-b6a9-d8953d552a66",
                  actor_type: "user",
                  actor_id: ACTOR_ID,
                  action: "connector.created",
                  resource_type: "connector",
                  resource_id: "ab9d2917-023a-4e7d-9132-9f7d93dd3d04",
                  resource_name: "Area filter connector",
                  trace_id: null,
                  result: "success",
                  reason: null,
                  before: null,
                  after: null,
                  metadata: {},
                },
              ]
            : entries.filter((entry) => resourceTypes.includes(entry.resource_type))
          : entries;
        return { ...body, items: visibleEntries, next_cursor: null };
      });
    const auditId = /^\/v1\/audit-log\/([^/]+)$/.exec(path)?.[1];
    if (auditId && entries.some((entry) => entry.id === auditId))
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entries.find((entry) => entry.id === auditId)),
      });
    if (path === "/v1/identity/api-keys")
      return transform(route, mockApi, (body) => {
        const base = body.items.find((key) => !key.revoked_at);
        require(base, "Management fixture requires an active API key");
        return {
          ...body,
          items: [
            {
              ...base,
              tenant_id: tenantId,
              allowed_workflows: null,
              allowed_connectors: null,
              rotated_from_id: null,
              id: "c622051a-6cf5-4e73-b30f-c8e6c2ac9d74",
              name: "Human evidence key",
              prefix: "wf_live_human",
              user_id: ACTOR_ID,
              system_account_id: null,
              created_at: "2024-01-01T12:00:00.000Z",
              last_used_at: USED_AT,
              expires_at: null,
              rotating_out_at: null,
              revoked_at: null,
            },
            {
              ...base,
              tenant_id: tenantId,
              allowed_workflows: null,
              allowed_connectors: null,
              rotated_from_id: null,
              id: "f2600615-eef2-47c1-ae1e-8a2cb7c9c246",
              name: "Service evidence key",
              prefix: "wf_live_service",
              user_id: null,
              system_account_id: ACTOR_ID,
              last_used_at: null,
              expires_at: null,
              rotating_out_at: null,
              revoked_at: null,
            },
          ],
        };
      });
    return route.fallback();
  };
  await page.route(ROUTE, handler);
  try {
    page.on("request", auditRequestListener);
    await stand.visit(page, "audit");
    await page
      .getByRole("heading", { name: t("resource.audit.title"), exact: true })
      .waitFor({ state: "visible" });
    const auditHeaders = await page
      .getByTestId("data-table-desktop")
      .getByRole("columnheader")
      .allInnerTexts();
    require(auditHeaders.map((header) => header.trim()).join(" · ") ===
      ["audit.column.event", "audit.column.actor", "audit.column.result", "audit.column.time"]
        .map((key) => t(key))
        .join(
          " · ",
        ), "Audit columns must follow the documented event, actor, result, time sequence");
    const summaryNote = page.getByTestId("audit-scope-note");
    const defaultWindowCount = translate(locale, "audit.countWindow", { count: 2 });
    require((await summaryNote.innerText()).trim() ===
      defaultWindowCount, "Default audit count must name the thirty-day window without an absolute-date chip");
    const areaFilter = page.getByTestId("audit-scope-filter");
    require((await areaFilter.innerText()).trim() ===
      t("audit.scope.all"), "Audit area filter must default to the localized all-events option");
    await areaFilter.click();
    const areaOptions = page.getByRole("option");
    const expectedAreaOptions = [
      "audit.scope.all",
      "resource.runs.title",
      "resource.workflows.title",
      "resource.connectors.title",
      "resource.knowledge.title",
      "resource.files.title",
      "nav.chat",
      "people.section.people",
    ].map(t);
    require((await areaOptions.allInnerTexts()).map((label) => label.trim()).join(" · ") ===
      expectedAreaOptions.join(
        " · ",
      ), "Audit area filter must expose every localized area option in the established order");
    const requestsBeforeConnectorFilter = auditRequests.length;
    await page.getByRole("option", { name: t("resource.connectors.title"), exact: true }).click();
    await contains(row(page, "data-table", 0), "Area filter connector", "connector area result");
    const connectorAreaRequest = auditRequests
      .slice(requestsBeforeConnectorFilter)
      .find(
        (request) =>
          request.searchParams.get("resource_types") === "connector,credential,connection",
      );
    require(connectorAreaRequest, "Selecting the connector area must request its exact resource types from the audit API");
    require((await row(page, "data-table", 1).count()) ===
      0, "Selecting the connector area must exclude every non-connector result");
    require((await row(page, "data-table", 0).innerText()).includes(
      t("audit.action.connectorCreated"),
    ), "Connector area results must contain the localized connector event");
    await areaFilter.click();
    await page.getByRole("option", { name: t("audit.scope.all"), exact: true }).click();
    const deleted = row(page, "data-table", 0);
    const unknown = row(page, "data-table", 1);
    await contains(deleted, DELETED_NAME, "saved deleted object name");
    await contains(deleted, EMAIL, "typed human audit actor");
    await excludes(deleted, [SERVICE, ACTOR_ID, DELETED_ID], "human audit identity");
    const deletedEvent = (await deleted.locator("td").first().innerText())
      .replace(/\s+/g, " ")
      .trim();
    require(deletedEvent ===
      `${t("audit.action.workflowDeleted")} · ${DELETED_NAME}`, `Deleted audit cell must show the localized action and saved object name: ${deletedEvent}`);
    await openRow(page, "data-table", 0);
    const auditDetail = page.getByTestId("audit-detail");
    await auditDetail.waitFor({ state: "visible" });
    const objectFact = fact(page, "audit-detail-facts", t("audit.detail.object"));
    await contains(objectFact, DELETED_NAME, "audit detail object name");
    const workflowOpen = page.getByTestId("audit-detail-open");
    await workflowOpen.waitFor({ state: "visible" });
    require((await workflowOpen.innerText()).trim() ===
      translateWithValues("audit.detail.openRecord", {
        resource: t("audit.resource.workflow"),
      }), "Deleted workflow detail must use the localized open-record action and workflow resource label");
    require(new URL(await workflowOpen.getAttribute("href"), page.url()).pathname ===
      `/cockpit/workflows/${DELETED_ID}`, "Deleted workflow action must target its exact workflow record");
    await page.getByTestId("audit-detail-menu").click();
    const wholeOperation = page.getByRole("menuitem", {
      name: t("audit.detail.wholeOperation"),
      exact: true,
    });
    await wholeOperation.waitFor({ state: "visible" });
    const wholeOperationUrl = new URL(await wholeOperation.getAttribute("href"), page.url());
    require(wholeOperationUrl.searchParams.get("trace_id") === DELETED_TRACE_ID &&
      wholeOperationUrl.searchParams.get("trace_id") !== "ef95c40f-acf2-474c-a19f-f909d36d5d8c" &&
      wholeOperationUrl.searchParams.get("scope") ===
        "all", "Whole-operation action must be gated by and target the exact trace, not the entry ID");
    await page.keyboard.press("Escape");
    const traceValue = page
      .getByTestId("audit-detail-facts")
      .locator(`span[title="${DELETED_TRACE_ID}"]`);
    const traceRow = traceValue.locator("..").locator("..");
    require((await traceRow.locator("dt").innerText()).trim() ===
      t("audit.detail.trace"), "Trace fact must use the localized operation label");
    require((await traceValue.innerText()).trim() ===
      `${DELETED_TRACE_ID.slice(0, 8)}…`, "Trace fact must show the short form of its operation UUID");
    require((await traceValue.getAttribute("title")) ===
      DELETED_TRACE_ID, "Trace fact title must retain the exact operation ID");
    const traceHelp = traceRow.getByRole("button", {
      name: t("audit.detail.trace"),
      exact: true,
    });
    await traceHelp.waitFor({ state: "visible" });
    await traceHelp.hover();
    await page
      .getByText(t("audit.detail.traceHelp"), { exact: true })
      .waitFor({ state: "visible" });
    await closeRecordSheet(auditDetail);
    await openRow(page, "data-table", 1);
    await page.getByTestId("audit-detail").waitFor({ state: "visible" });
    require((await page.getByTestId("audit-detail-menu").count()) ===
      0, "Whole-operation action must be absent when the audit entry has no trace");
    await closeRecordSheet(page.getByTestId("audit-detail"));
    require(auditWrites.length ===
      0, `Audit evidence journey made writes: ${JSON.stringify(auditWrites)}`);
    page.off("request", auditRequestListener);
    await contains(unknown, SERVICE, "typed service audit actor");
    await contains(unknown, t("audit.resource.workflow"), "unknown object kind fallback");
    await excludes(unknown, [EMAIL, DELETED_NAME, ACTOR_ID, UNKNOWN_ID], "unknown audit object");
    await capture("management-audit-saved-and-unknown");

    await stand.visit(
      page,
      `audit?ts_from=${encodeURIComponent(customFrom)}&ts_to=${encodeURIComponent(customTo)}`,
    );
    const customRangeLabel = windowFilterLabel(
      customFrom,
      customTo,
      translateWithValues,
      formatDate,
    );
    require((await page.getByTestId("audit-window-filter").innerText()).trim() ===
      customRangeLabel, "Explicit audit time range must retain its localized filter label");
    const customSummary = translate(locale, "audit.count", { count: 2 });
    require((await summaryNote.innerText()).trim() ===
      `${customSummary} · ${customRangeLabel}`, "Explicit audit time range must keep generic count copy and show its range");

    await verifyPeopleLoadsPerTab(page, stand, `management evidence (${locale})`);
    await page.getByTestId("people-search").fill(EMAIL);
    const targetPersonLink = page
      .locator(
        '[data-testid^="people-list-row-link-"], [data-testid^="people-list-mobile-row-link-"]',
      )
      .filter({ visible: true, hasText: EMAIL })
      .first();
    await targetPersonLink.click();
    const personSheet = page.getByTestId("people-sheet");
    await personSheet.waitFor({ state: "visible" });
    require((await fact(page, "people-sheet-facts", t("people.email")).innerText()).trim() ===
      EMAIL, "Person sheet must show the exact email address independently from the display name");
    require((await page.getByTestId("people-role").innerText()).trim() ===
      t(
        "role.member",
      ), "Person sheet must show the effective role alongside the saved group membership");
    await contains(page.getByTestId("people-sheet-groups"), GROUP, "saved human group membership");
    await capture("management-person-groups");
    await page.getByTestId("people-deactivate").click();
    const deactivateDialog = page.getByTestId("people-deactivate-confirm");
    await deactivateDialog.waitFor({ state: "visible" });
    const deactivationConsequence = translate(locale, "people.deactivateConsequence");
    require((
      await deactivateDialog.getByTestId("people-deactivate-confirm-consequence").innerText()
    ).trim() ===
      deactivationConsequence, "Deactivation must explain sign-in/access impact and that workflows and schedules continue");
    const deactivationWrites = [];
    const captureDeactivationWrite = (request) => {
      if (
        request.method() !== "GET" &&
        new URL(request.url()).pathname === `/v1/identity/users/${ACTOR_ID}`
      )
        deactivationWrites.push(request.method());
    };
    page.on("request", captureDeactivationWrite);
    await deactivateDialog.getByTestId("people-deactivate-confirm-cancel").click();
    await deactivateDialog.waitFor({ state: "hidden" });
    page.off("request", captureDeactivationWrite);
    require(deactivationWrites.length ===
      0, "Canceling deactivation must not issue a user mutation");
    await closeRecordSheet(personSheet);
    await stand.visit(page, "people?section=groups");
    const groupHeaders = await page
      .getByTestId("groups-list-desktop")
      .getByRole("columnheader")
      .allInnerTexts();
    require(groupHeaders.map((header) => header.trim()).join(" · ") ===
      ["access.group", "access.members"]
        .map((key) => t(key))
        .join(" · "), "Group columns must follow the localized group, members sequence");
    await contains(row(page, "groups-list", 0), GROUP, "group list name");
    await openRow(page, "groups-list", 0);
    require((await page.getByTestId("groups-members-note").innerText()).trim() ===
      "1", "Group member_count must be the stored count");
    await capture("management-group-count");

    await stand.visit(page, "people?section=roles");
    for (const [name, visibleRights, overflow, members] of [
      ["Evidence pair", 2, null, "7"],
      ["Evidence expanded", 4, translate(locale, "people.change.more", { count: "2" }), "19"],
      ["Evidence empty", 0, null, "0"],
    ]) {
      const role = page
        .locator('[data-testid^="roles-list-row-"], [data-testid^="roles-list-mobile-row-"]')
        .filter({ visible: true })
        .filter({ has: page.getByText(name, { exact: true }) })
        .filter({ has: page.getByTestId("role-row-permissions") });
      await role.waitFor({ state: "visible" });
      const rights = role.getByTestId("role-row-permissions").locator(":scope > li");
      require((await rights.count()) ===
        visibleRights, `${name}: incorrect visible rights or remainder count`);
      if (overflow !== null)
        require((await rights.last().innerText()).trim() ===
          overflow, `${name}: five rights must retain the two hidden rights`);
      const cells = role.locator(":scope > td");
      const count =
        (await cells.count()) > 0
          ? cells.nth(2)
          : role.locator('[data-family-slot="card-fact"]').last();
      require((await count.innerText()).trim() ===
        members, `${name}: incorrect stored member count`);
    }
    await capture("management-role-rights-members");

    const rolesSummary = page.getByTestId("roles-summary");
    await rolesSummary.waitFor({ state: "visible" });
    const roleHeaders = await page
      .getByTestId("roles-list-desktop")
      .getByRole("columnheader")
      .allInnerTexts();
    require(roleHeaders.map((header) => header.trim()).join(" · ") ===
      ["people.role", "access.rolePermissions", "access.members"]
        .map((key) => t(key))
        .join(" · "), "Role columns must follow the localized role, permissions, members sequence");
    require((await rolesSummary.getByTestId("roles-summary-help").count()) ===
      1, "Role help must be attached to the roles summary");
    require((await rolesSummary.locator('[data-slot="summary-line-text"]').innerText()).trim() ===
      translate(locale, "access.rolesSummary", {
        count: 3,
      }), "Role summary must show the localized count");
    await rolesSummary.getByTestId("roles-summary-help").hover();
    const rolesHelp = page.locator('[data-slot="tooltip-content"]').filter({ visible: true });
    await rolesHelp.waitFor({ state: "visible" });
    require((await rolesHelp.innerText()).trim() ===
      t("access.rolesHelp"), "Role summary help must show its localized explanation");
    await page.mouse.move(0, 0);

    await stand.visit(page, "people?section=grants");
    const grantsSummary = page.getByTestId("grants-summary");
    await grantsSummary.waitFor({ state: "visible" });
    require((await grantsSummary.locator('[data-slot="summary-line-text"]').innerText()).trim() ===
      translate(locale, "access.workflowGrants.other", {
        count: 3,
      }), "Workflow grant summary must name the individual workflows and localized count");
    require((await grantsSummary.locator("[data-help-description]").innerText()).trim() ===
      t("access.grantsHelp"), "Workflow grant summary must expose its localized help text");
    const grantsHeaders = await page
      .getByTestId("grants-list-desktop")
      .getByRole("columnheader")
      .allInnerTexts();
    require(grantsHeaders.map((header) => header.trim()).join(" · ") ===
      ["access.grant", "access.right", "access.validity"]
        .map((key) => t(key))
        .join(" · "), "Grant columns must follow the localized access, right, validity sequence");
    require((
      await page.getByTestId("grants-list-row-0").locator("td").nth(2).innerText()
    ).trim() === t("status.active"), "Grant row must show the localized active validity badge");
    await capture("management-workflow-grants-summary-validity");

    await stand.visit(page, "api-access?section=keys");
    const usedText = await page.evaluate(
      ({ tag, value }) =>
        new Intl.DateTimeFormat(tag, { dateStyle: "medium" }).format(new Date(value)),
      { tag: LOCALE_TAGS[locale], value: USED_AT },
    );
    for (const [index, owner, other, lastUsed] of [
      [0, EMAIL, SERVICE, usedText],
      [1, SERVICE, EMAIL, t("apiKeys.neverUsed")],
    ]) {
      await contains(
        row(page, "api-keys", index),
        index === 0 ? "Human evidence key" : "Service evidence key",
        "API key row order",
      );
      if (await page.getByTestId(`api-keys-row-${index}`).isVisible())
        await contains(row(page, "api-keys", index), lastUsed, "API key last use in desktop list");
      await openRow(page, "api-keys", index);
      await contains(
        fact(page, "api-key-sheet-facts", t("apiKeys.owner")),
        owner,
        "typed API key owner",
      );
      await excludes(
        fact(page, "api-key-sheet-facts", t("apiKeys.owner")),
        [other, ACTOR_ID],
        "API key owner collision",
      );
      await contains(
        fact(page, "api-key-sheet-facts", t("apiAccess.column.lastUsed")),
        lastUsed,
        "API key last use in detail",
      );
      await capture(index === 0 ? "management-key-used-human" : "management-key-unused-service");
      await closeRecordSheet(page.getByTestId("api-key-sheet"));
    }
  } finally {
    page.off("request", auditRequestListener);
    await page.unroute(ROUTE, handler);
  }
}
