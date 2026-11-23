import { expect } from "bun:test";
import type { Locale } from "@/lib/i18n";
import { type Journey, journeys, json, mount } from "./journey-fixtures";
import { ALL_PERMISSIONS, type Handler, NOW, TENANT, USER } from "./workspace-journey-fixtures";

const isolated = journeys(import.meta.path);

const INVITED = "88888888-8888-4888-8888-888888888888";
const INVITE = "99999999-9999-4999-8999-999999999999";
const TOKEN = "skinv_journey0123456789abcdef";
const EMAIL = "jonas@example.com";
const ROLE_IDS: Record<string, string> = {
  admin: "aaaaaaaa-0000-4000-8000-000000000001",
  member: "aaaaaaaa-0000-4000-8000-000000000002",
  enduser: "aaaaaaaa-0000-4000-8000-000000000003",
};
const ROLE_PERMISSIONS = {
  admin: ["identity:read", "identity:write", "rbac:read", "workflow:read"],
  member: ["workflow:read", "workflow:write", "workflow:run"],
  enduser: ["workflow:run"],
};

type Person = Record<string, unknown> & { id: string; role: string; status: string };

function person(id: string, email: string, role: string, status: string): Person {
  return {
    id,
    tenant_id: TENANT,
    email,
    display_name: id === USER ? "Mira" : null,
    role,
    status,
    oauth_connections: 0,
    created_at: NOW,
    updated_at: NOW,
    groups: [],
    identities: [],
  };
}

function peopleBackend() {
  const people: Person[] = [person(USER, "mira@example.com", "admin", "active")];
  const sent: { method: string; path: string; body: unknown }[] = [];
  const roles = Object.keys(ROLE_IDS).map((name) => ({
    id: ROLE_IDS[name],
    tenant_id: null,
    name,
    description: null,
    is_builtin: true,
    created_at: NOW,
    updated_at: NOW,
    permissions: ROLE_PERMISSIONS[name as keyof typeof ROLE_PERMISSIONS],
    member_count: people.filter((entry) => entry.role === name).length,
  }));
  const body = (init: RequestInit | undefined) => JSON.parse(String(init?.body ?? "{}"));
  const routes: Record<string, Handler> = {
    "GET /v1/identity/users": () => ({ items: people, next_cursor: null, total: people.length }),
    "POST /v1/identity/users": (_url, init) => {
      const request = body(init) as { email: string; role: string };
      sent.push({ method: "POST", path: "/v1/identity/users", body: request });
      const created = person(INVITED, request.email, request.role, "invited");
      people.push(created);
      return json(
        {
          ...created,
          invite: {
            id: INVITE,
            tenant_id: TENANT,
            user_id: INVITED,
            prefix: TOKEN.slice(0, 10),
            scopes: [],
            allowed_workflows: null,
            allowed_connectors: null,
            expires_at: "2026-11-30T10:00:00.000Z",
            redeemed_at: null,
            revoked_at: null,
            created_by: USER,
            created_at: NOW,
            plaintext_token: TOKEN,
          },
        },
        201,
      );
    },
    [`PATCH /v1/identity/users/${INVITED}`]: (_url, init) => {
      const request = body(init) as { role?: string };
      sent.push({ method: "PATCH", path: `/v1/identity/users/${INVITED}`, body: request });
      const target = people.find((entry) => entry.id === INVITED);
      if (target && request.role) target.role = request.role;
      return target;
    },
    "GET /v1/rbac/roles": () => ({ items: roles }),
    "GET /v1/rbac/roles/([^/]+)": (url) =>
      roles.find((role) => url.pathname.endsWith(`/${role.id}`)) ?? json({}, 404),
    "GET /v1/rbac/grants": () => ({ items: [] }),
    "GET /v1/rbac/groups": () => ({ items: [] }),
    "GET /v1/rbac/permissions": () => ({
      items: (ROLE_PERMISSIONS.admin ?? []).map((name) => ({
        name,
        description: name,
        operator: false,
      })),
    }),
  };
  return { routes, sent };
}

function rowOf(app: Journey, email: string): number {
  const names = [...app.dom.window.document.querySelectorAll('[data-testid^="people-name-"]')];
  const found = names.findIndex((node) => (node.textContent ?? "").includes(email));
  if (found < 0) throw new Error(`${email} is not listed`);
  return Number((names[found] as HTMLElement).dataset.testid?.replace("people-name-", ""));
}

async function inviteRolesChange(locale: Locale) {
  const backend = peopleBackend();
  const app = await mount("/settings?area=people", {
    locale,
    permissions: ALL_PERMISSIONS,
    routes: backend.routes,
  });
  const roleLabel = (name: string) => app.t(`role.${name}` as "role.admin");
  app.at("/settings");
  expect(app.find("admin-people")).not.toBeNull();
  expect(app.text()).toContain("mira@example.com");

  await app.click("people-create");
  expect(app.find("people-create-dialog")).not.toBeNull();
  await app.fill("people-create-email", EMAIL);
  await app.press("people-create-role");
  await app.clickText(roleLabel("enduser"), "[role=option]");
  await app.click("people-create-dialog-submit");
  expect(app.seen).toContain("POST /v1/identity/users");
  expect(backend.sent).toEqual([
    {
      method: "POST",
      path: "/v1/identity/users",
      body: { email: EMAIL, role: "enduser", invite: {} },
    },
  ]);
  expect(app.find("people-invite-link-body")?.textContent).toBe(
    app.t("people.invite.link.body", { email: EMAIL }),
  );
  expect((app.find("people-invite-link") as HTMLInputElement | null)?.value).toContain(
    `/cockpit/invite#${TOKEN}`,
  );
  await app.click("people-create-dialog-submit");
  expect(app.find("people-create-dialog")).toBeNull();
  expect(app.text()).not.toContain(TOKEN);
  const invitedRow = rowOf(app, EMAIL);
  expect(app.find(`people-role-badge-${invitedRow}`)?.textContent).toBe(roleLabel("enduser"));

  await app.press("people-tab-roles");
  app.at("/settings");
  expect(app.dom.window.location.search).toContain("section=roles");
  expect(app.find("roles-section")).not.toBeNull();
  for (const name of Object.keys(ROLE_IDS)) expect(app.text()).toContain(roleLabel(name));
  await app.click("roles-list-row-link-0");
  expect(app.find("role-sheet")).not.toBeNull();
  expect(app.seen).toContain(`GET /v1/rbac/roles/${ROLE_IDS.admin}`);
  await app.click("role-sheet-close");
  expect(app.find("role-sheet")).toBeNull();

  await app.press("people-tab-people");
  expect(app.find("admin-people")).not.toBeNull();
  await app.click(`people-list-row-link-${rowOf(app, EMAIL)}`);
  expect(app.find("people-sheet")).not.toBeNull();
  await app.press("people-role");
  await app.click("people-role-member");
  expect(app.find("people-role-change")).not.toBeNull();
  expect(app.find("people-save-bar")).not.toBeNull();
  await app.click("people-role-save");
  expect(app.seen).toContain(`PATCH /v1/identity/users/${INVITED}`);
  expect(backend.sent.at(-1)).toEqual({
    method: "PATCH",
    path: `/v1/identity/users/${INVITED}`,
    body: { role: "member" },
  });
  expect(app.find("people-save-bar")).toBeNull();
  expect(app.find(`people-role-badge-${rowOf(app, EMAIL)}`)?.textContent).toBe(roleLabel("member"));
  expect(app.missingKeys()).toEqual([]);
  app.at("/settings");
}

isolated("Admin (de) › invite a person, read the roles and change the role", () =>
  inviteRolesChange("de"),
);

isolated("Admin (en) › invite a person, read the roles and change the role", () =>
  inviteRolesChange("en"),
);
