import { LOCALE_TAGS, translate } from "../../apps/cockpit/src/lib/i18n.ts";
import { verifyPeopleLoadsPerTab } from "./cockpit-people-tabs.mjs";

const ACTOR_ID = "8b18c6a4-00e7-4c3b-b044-2a04d6915842";
const GROUP_ID = "15683d9a-42c7-49d8-9549-40a19eb15f44";
const DELETED_ID = "56bef7bf-6cc6-4949-9551-981048fd04c5";
const UNKNOWN_ID = "3e9e99fc-c279-4a42-9c2b-b2e9a0b7c80f";
const EMAIL = "management-reader@example.test";
const SERVICE = "Management automation";
const GROUP = "Evidence reviewers";
const DELETED_NAME = "Archived reconciliation";
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
  const t = (key) => translate(locale, key);
  let entries = [];
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
    if (path === "/v1/audit-log")
      return transform(route, mockApi, (body) => {
        require(body.items.length > 0, "Management fixture requires an audit base row");
        entries = [
          {
            ...body.items[0],
            id: "ef95c40f-acf2-474c-a19f-f909d36d5d8c",
            actor_type: "user",
            actor_id: ACTOR_ID,
            action: "workflow.deleted",
            resource_type: "workflow",
            resource_id: DELETED_ID,
            resource_name: DELETED_NAME,
            result: "success",
            reason: null,
            before: null,
            after: null,
            metadata: {},
          },
          {
            ...body.items[0],
            id: "b06359bf-a046-41ea-8765-b3b081b92a26",
            actor_type: "system_account",
            actor_id: ACTOR_ID,
            action: "workflow.deleted",
            resource_type: "workflow",
            resource_id: UNKNOWN_ID,
            resource_name: null,
            result: "success",
            reason: null,
            before: null,
            after: null,
            metadata: {},
          },
        ];
        return { ...body, items: entries, next_cursor: null };
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
    await stand.visit(page, "audit?scope=all&ts_from=2020-01-01T00%3A00%3A00.000Z");
    const deleted = row(page, "data-table", 0);
    const unknown = row(page, "data-table", 1);
    await contains(deleted, DELETED_NAME, "saved deleted object name");
    await contains(deleted, EMAIL, "typed human audit actor");
    await excludes(deleted, [SERVICE, ACTOR_ID, DELETED_ID], "human audit identity");
    await contains(unknown, SERVICE, "typed service audit actor");
    await contains(unknown, t("nav.workflows"), "unknown object kind fallback");
    await excludes(unknown, [EMAIL, DELETED_NAME, ACTOR_ID, UNKNOWN_ID], "unknown audit object");
    await capture("management-audit-saved-and-unknown");

    await verifyPeopleLoadsPerTab(page, stand, `management evidence (${locale})`);
    await openRow(page, "people-list", 0);
    await contains(page.getByTestId("people-sheet-groups"), GROUP, "saved human group membership");
    await capture("management-person-groups");
    await page.getByTestId("people-sheet").locator('[data-slot="sheet-close"]').click();
    await stand.visit(page, "people?section=groups");
    await contains(row(page, "groups-list", 0), GROUP, "group list name");
    await openRow(page, "groups-list", 0);
    require((await page.getByTestId("groups-members-note").innerText()).trim() ===
      "1", "Group member_count must be the stored count");
    await capture("management-group-count");

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
      await page.getByTestId("api-key-sheet").locator('[data-slot="sheet-close"]').click();
    }
  } finally {
    await page.unroute(ROUTE, handler);
  }
}
