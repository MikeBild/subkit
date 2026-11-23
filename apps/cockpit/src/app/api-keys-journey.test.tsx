import { expect } from "bun:test";
import type { Locale } from "@/lib/i18n";
import { type Journey, journeys, json, mount } from "./journey-fixtures";
import { ALL_PERMISSIONS, type Handler, NOW, TENANT, USER } from "./workspace-journey-fixtures";

const isolated = journeys(import.meta.path);

const KEY = "66666666-6666-4666-8666-666666666666";
const CLIENT = "77777777-7777-4777-8777-777777777777";
const SECRET = "sk_live_journey_secret_0123456789abcdef";
const KEY_NAME = "Deploy bot";
const CLIENT_NAME = "Claude Desktop";

function keysBackend() {
  const keys: Record<string, unknown>[] = [];
  const created: unknown[] = [];
  const client = {
    id: CLIENT,
    client_id: "mcp-client-journey",
    client_name: CLIENT_NAME,
    redirect_uris: ["http://127.0.0.1:7777/callback"],
    registration_source: "dcr",
    approved_by: [USER],
    live_connections: 1,
    connected_by: {
      grants: [
        {
          user_id: USER,
          display_name: "Mira",
          email: "mira@example.com",
          connected_at: NOW,
          revoked_at: null,
        },
      ],
      has_unknown_legacy: false,
    },
    disabled_at: null,
    retired_at: null,
    created_at: NOW,
    last_used_at: NOW,
  };
  const routes: Record<string, Handler> = {
    "GET /v1/identity/api-keys": () => ({ items: keys }),
    "POST /v1/identity/api-keys": (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { name: string; scopes: string[] };
      created.push(body);
      const key = {
        id: KEY,
        tenant_id: TENANT,
        prefix: SECRET.slice(0, 12),
        name: body.name,
        scopes: body.scopes,
        user_id: USER,
        system_account_id: null,
        creator: { kind: "user", id: USER },
        allowed_workflows: null,
        allowed_connectors: null,
        created_at: NOW,
        last_used_at: NOW,
        expires_at: null,
        rotating_out_at: null,
        rotated_from_id: null,
        revoked_at: null,
      };
      keys.push(key);
      return json({ ...key, plaintext_key: SECRET }, 201);
    },
    [`DELETE /v1/identity/api-keys/${KEY}`]: () => {
      const key = keys.find((entry) => entry.id === KEY);
      if (key) key.revoked_at = NOW;
      return key;
    },
    "GET /v1/oauth/clients": () => ({ items: [client] }),
  };
  return { routes, created };
}

function secretVisible(app: Journey): boolean {
  if (app.text().includes(SECRET)) return true;
  return [...app.dom.window.document.querySelectorAll("input, textarea")].some(
    (field) => (field as HTMLInputElement).value === SECRET,
  );
}

async function createShowRevoke(locale: Locale) {
  const backend = keysBackend();
  const app = await mount("/api-access", {
    locale,
    permissions: ALL_PERMISSIONS,
    routes: backend.routes,
  });
  app.at("/api-access");
  expect(app.find("admin-api-access")).not.toBeNull();
  expect(app.text()).toContain(app.t("apiKeys.emptyTitle"));

  await app.click("api-key-create");
  expect(app.find("api-key-create-dialog")).not.toBeNull();
  await app.fill("api-key-create-name", KEY_NAME);
  await app.click("api-key-create-dialog-submit");
  expect(app.seen).toContain("POST /v1/identity/api-keys");
  expect(backend.created).toEqual([
    expect.objectContaining({ owner_kind: "user", owner_id: USER, name: KEY_NAME }),
  ]);
  expect(app.find("api-key-create-dialog")).toBeNull();
  expect((app.find("secret-value") as HTMLInputElement | null)?.value).toBe(SECRET);
  expect(app.find("secret-once")?.textContent).toBe(app.t("secret.once"));
  expect(app.find("secret-dialog-title")?.textContent).toBe(
    app.t("apiKeys.createdNamed", { name: KEY_NAME }),
  );

  await app.click("secret-dialog-submit");
  expect(app.find("secret-dialog")).toBeNull();
  expect(secretVisible(app)).toBe(false);
  expect(app.text()).toContain(KEY_NAME);
  app.at("/api-access");

  await app.go("/settings");
  app.at("/settings");
  await app.go("/api-access");
  app.at("/api-access");
  expect(secretVisible(app)).toBe(false);
  expect(app.find("secret-dialog")).toBeNull();
  expect(app.text()).toContain(KEY_NAME);

  await app.press("api-key-menu-0");
  await app.click("api-key-0-revoke");
  expect(app.find("api-key-revoke-dialog-title")).not.toBeNull();
  await app.click("api-key-revoke-dialog-confirm");
  expect(app.seen).toContain(`DELETE /v1/identity/api-keys/${KEY}`);
  expect(app.find("api-key-revoke-dialog")).toBeNull();
  expect(app.find("api-keys-revoked")).not.toBeNull();
  expect(app.find("api-key-menu-0")).toBeNull();
  expect(secretVisible(app)).toBe(false);
  expect(app.missingKeys()).toEqual([]);
  app.at("/api-access");
}

async function connectedClients(locale: Locale) {
  const backend = keysBackend();
  const app = await mount("/api-access", {
    locale,
    permissions: ALL_PERMISSIONS,
    routes: backend.routes,
  });
  app.at("/api-access");
  await app.press("api-access-tab-clients");
  app.at("/api-access");
  expect(app.dom.window.location.search).toContain("section=clients");
  expect(app.find("api-access-section-clients")).not.toBeNull();
  expect(app.seen).toContain("GET /v1/oauth/clients");
  expect(app.find("api-access-total-clients")?.textContent).toContain(
    app.t("apiAccess.total.clientsOne"),
  );
  expect(app.text()).toContain(CLIENT_NAME);
  expect(app.text()).toContain("Mira");
  expect(app.missingKeys()).toEqual([]);

  await app.go("/settings");
  app.at("/settings");
  await app.back();
  app.at("/api-access");
  expect(app.dom.window.location.search).toContain("section=clients");
  expect(app.find("api-access-section-clients")).not.toBeNull();
  await app.forward();
  app.at("/settings");
  await app.back();
  expect(app.find("api-access-section-clients")).not.toBeNull();
  expect(app.text()).toContain(CLIENT_NAME);
}

isolated("API keys (de) › a new key shows its secret once and can be revoked", () =>
  createShowRevoke("de"),
);

isolated("API keys (en) › a new key shows its secret once and can be revoked", () =>
  createShowRevoke("en"),
);

isolated("MCP connections (de) › connected clients are listed with who connected them", () =>
  connectedClients("de"),
);

isolated("MCP connections (en) › connected clients are listed with who connected them", () =>
  connectedClients("en"),
);
