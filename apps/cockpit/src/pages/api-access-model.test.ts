import { describe, expect, test } from "bun:test";
import { CATALOGS, type TranslationKey } from "@/lib/i18n";
import {
  API_ACCESS_ORDER,
  type ApiKeyItem,
  apiAccessAttention,
  type ConnectedClientItem,
  deepLinkReady,
  defaultKeyScopes,
  groupApiKeys,
  groupConnectedClients,
  keyIdleDays,
  readableSections,
  scopeCatalogue,
  scopeLabel,
  scopeRisk,
  UNUSED_KEY_DAYS,
} from "./api-access-model";
import type { ConnectionItem } from "./connections-model";

const DE = CATALOGS.de;
const t = (key: TranslationKey, values: Record<string, string | number> = {}) =>
  Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    DE[key],
  );
const dateTime = (value: string) => value.slice(0, 10);

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function key(overrides: Partial<ApiKeyItem>): ApiKeyItem {
  return {
    id: "k1",
    tenant_id: "t1",
    prefix: "sk_live_ab12",
    name: "Reporting",
    scopes: ["workflow:read"],
    user_id: "u1",
    system_account_id: null,
    allowed_workflows: null,
    allowed_connectors: null,
    created_at: daysAgo(10),
    last_used_at: daysAgo(1),
    expires_at: null,
    rotating_out_at: null,
    rotated_from_id: null,
    revoked_at: null,
    ...overrides,
  };
}

function grant(overrides: Partial<ConnectionItem>): ConnectionItem {
  return {
    id: "c1",
    name: "postfach",
    base_url: "https://mail.example.com",
    issuer: "https://login.example.com",
    service_name: "Postfach",
    service_description: null,
    scopes: ["mail.send"],
    granted_scopes: null,
    state: "valid",
    state_reason: null,
    auto_renew: true,
    expires_at: null,
    last_used_at: null,
    last_refreshed_at: null,
    refresh_failed_at: null,
    last_error: null,
    used_by: [],
    created_at: daysAgo(30),
    ...overrides,
  };
}

describe("scope labels", () => {
  test("a scope reads as a name and a risk word, never as the raw string", () => {
    expect(scopeLabel("workflow:run", t)).toEqual({
      text: "Workflows · Ausführen",
      machine: false,
    });
    expect(scopeLabel("connection:read", t).machine).toBe(false);
    expect(scopeLabel("*", t)).toEqual({ text: "Alle Rechte deiner Rolle", machine: false });
  });

  test("reading never hides writing, and rights over rights are managing", () => {
    expect(scopeRisk("workflow:read")).toBe("reads");
    expect(scopeRisk("audit:list")).toBe("reads");
    expect(scopeRisk("workflow:run")).toBe("writes");
    expect(scopeRisk("connector:write")).toBe("writes");
    expect(scopeRisk("api_key:write")).toBe("manages");
    expect(scopeRisk("rbac:write")).toBe("manages");
    expect(scopeRisk("workflow:delete")).toBe("manages");
    expect(scopeRisk("*")).toBe("manages");
    // An action this build does not know is never understated as reading.
    expect(scopeRisk("workflow:teleport")).toBe("writes");
  });

  test("the catalogue is what the person holds, wildcard first, reading before changing", () => {
    expect(
      scopeCatalogue(["rbac:write", "workflow:run", "workflow:read", "workflow:read"]),
    ).toEqual(["*", "workflow:read", "workflow:run", "rbac:write"]);
    expect(defaultKeyScopes(["workflow:read"])).toEqual(["workflow:read"]);
  });
});

describe("attention on Zugangsdaten", () => {
  test("nothing to say when every grant and key is fine", () => {
    expect(
      apiAccessAttention({ connections: [grant({})], keys: [key({})], nowMs: NOW }, t, dateTime),
    ).toEqual([]);
  });

  test("a lost grant is critical, says why in German, and never a dash", () => {
    const items = apiAccessAttention(
      {
        connections: [
          grant({
            state: "expired",
            state_reason: "expired_no_refresh",
          }),
          grant({
            id: "c2",
            name: "lager",
            service_name: null,
            state: "expired",
            state_reason: "refresh_refused",
            last_error: "token endpoint refused: invalid_grant",
          }),
          grant({ id: "c3", state: "unreadable", state_reason: "secret_unreadable" }),
        ],
        keys: [],
        nowMs: NOW,
      },
      t,
      dateTime,
    );
    expect(items.map((item) => item.tone)).toEqual(["critical", "critical", "critical"]);
    expect(items[0]?.text).toBe(
      `Die Kontoverbindung Postfach ist abgelaufen. ${DE["connections.reason.expiredNoRefresh"]}`,
    );
    expect(items[1]?.text).toContain(DE["connections.reason.refreshRefused"]);
    expect(items[1]?.engineWording).toBe("token endpoint refused: invalid_grant");
    expect(items[2]?.text).toContain("nicht lesbar");
    for (const item of items) {
      expect(item.text).not.toContain("—");
      expect(item.href).toBe("/cockpit/api-access?section=grants");
    }
  });

  test("a key past its expiry is critical; an idle one is a warning; a revoked one is silent", () => {
    const items = apiAccessAttention(
      {
        connections: [],
        keys: [
          key({ id: "expired", expires_at: daysAgo(2) }),
          key({ id: "idle", last_used_at: daysAgo(UNUSED_KEY_DAYS + 5) }),
          key({ id: "never", last_used_at: null, created_at: daysAgo(UNUSED_KEY_DAYS + 1) }),
          key({ id: "revoked", expires_at: daysAgo(2), revoked_at: daysAgo(1) }),
          key({ id: "fresh", last_used_at: null, created_at: daysAgo(3) }),
        ],
        nowMs: NOW,
      },
      t,
      dateTime,
    );
    expect(items.map((item) => [item.id, item.tone])).toEqual([
      ["key-expired:expired", "critical"],
      ["key-idle:idle", "warning"],
      ["key-idle:never", "warning"],
    ]);
    expect(items[1]?.text).toContain(`seit ${UNUSED_KEY_DAYS + 5} Tagen`);
    expect(items[2]?.text).toContain("nie benutzt");
    expect(items[0]?.href).toBe("/cockpit/api-access?section=keys");
  });

  test("idle days count from creation when a key was never used", () => {
    expect(keyIdleDays({ last_used_at: null, created_at: daysAgo(UNUSED_KEY_DAYS) }, NOW)).toBe(
      UNUSED_KEY_DAYS,
    );
    expect(keyIdleDays({ last_used_at: daysAgo(1), created_at: daysAgo(400) }, NOW)).toBeNull();
  });
});

function client(overrides: Partial<ConnectedClientItem>): ConnectedClientItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    client_id: "c-1",
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    registration_source: "dcr",
    approved_by: ["anna@example.com"],
    live_connections: 1,
    disabled_at: null,
    retired_at: null,
    created_at: daysAgo(30),
    ...overrides,
  };
}

describe("connected applications, in the order a reader needs them", () => {
  // Production: 494 registrations by a deploy verifier against four real
  // applications. Listed flat, the real ones drowned.
  const dead = Array.from({ length: 200 }, (_, index) =>
    client({
      id: `dead-${index}`,
      client_id: `dead-${index}`,
      client_name: "Deploy verify",
      approved_by: [],
      live_connections: 0,
      created_at: daysAgo(index % 5),
    }),
  );
  const retired = Array.from({ length: 30 }, (_, index) =>
    client({
      id: `retired-${index}`,
      client_id: `retired-${index}`,
      client_name: "Deploy verify",
      approved_by: [],
      live_connections: 0,
      disabled_at: daysAgo(2),
      retired_at: daysAgo(2),
    }),
  );
  const revoked = client({
    id: "revoked",
    client_id: "revoked",
    approved_by: [],
    live_connections: 0,
    disabled_at: daysAgo(40),
  });
  const real = [
    client({ id: "claude", client_name: "Claude", created_at: daysAgo(60) }),
    client({ id: "chatgpt", client_name: "ChatGPT", created_at: daysAgo(20) }),
    client({ id: "watchkit", client_name: "WatchKit", created_at: daysAgo(3) }),
  ];
  // Interleaved as the engine returns them: no order at all.
  const all = [
    ...dead.slice(0, 100),
    real[0],
    revoked,
    ...retired,
    real[1],
    ...dead.slice(100),
    real[2],
  ].filter((item): item is ConnectedClientItem => Boolean(item));

  test("the applications someone holds a valid grant for lead, newest first", () => {
    const groups = groupConnectedClients(all);
    expect(groups.granted.map((item) => item.id)).toEqual(["watchkit", "chatgpt", "claude"]);
  });

  test("registrations nobody holds a grant for are a group of their own", () => {
    const groups = groupConnectedClients(all);
    expect(groups.ungranted).toHaveLength(200);
    expect(groups.ungranted.every((item) => item.live_connections === 0)).toBe(true);
  });

  test("retired and revoked registrations are apart from both, whatever their grants", () => {
    const groups = groupConnectedClients(all);
    expect(groups.disabled).toHaveLength(31);
    // A disabled registration is never listed with the live ones, even if a
    // stale count still says it has connections.
    const stale = client({ id: "stale", disabled_at: daysAgo(1), live_connections: 2 });
    expect(groupConnectedClients([stale]).granted).toEqual([]);
    expect(groupConnectedClients([stale]).disabled.map((item) => item.id)).toEqual(["stale"]);
  });

  test("nothing is lost between the groups", () => {
    const groups = groupConnectedClients(all);
    expect(groups.granted.length + groups.ungranted.length + groups.disabled.length).toBe(
      all.length,
    );
  });
});

describe("API keys: live first, revoked collapsed", () => {
  const revokedKeys = Array.from({ length: 40 }, (_, index) =>
    key({ id: `rev-${index}`, revoked_at: daysAgo(index + 1) }),
  );
  const activeKeys = Array.from({ length: 5 }, (_, index) => key({ id: `live-${index}` }));
  const expired = key({ id: "expired", expires_at: daysAgo(2) });

  test("a key that still holds rights is active — an expired one too, it needs a decision", () => {
    const groups = groupApiKeys([
      ...revokedKeys.slice(0, 20),
      ...activeKeys,
      expired,
      ...revokedKeys.slice(20),
    ]);
    expect(groups.active.map((item) => item.id)).toEqual([
      "live-0",
      "live-1",
      "live-2",
      "live-3",
      "live-4",
      "expired",
    ]);
    expect(groups.revoked).toHaveLength(40);
  });
});

describe("the order of the sections and when a deep link may scroll", () => {
  test("Kontoverbindungen comes first, the applications last", () => {
    // The OAuth callback and the old /connections address land on grants;
    // it used to sit below ~500 application rows.
    expect([...API_ACCESS_ORDER]).toEqual(["grants", "keys", "clients"]);
  });

  test("a section the reader may not read is absent, the order stays", () => {
    expect(readableSections({ grants: true, keys: false, clients: true })).toEqual([
      "grants",
      "clients",
    ]);
    expect(readableSections({ grants: false, keys: false, clients: false })).toEqual([]);
  });

  test("a deep link waits until no readable list is loading", () => {
    // Scrolling on mount landed on a heading the arriving lists then pushed
    // out of view.
    expect(deepLinkReady(["loading", "ready", "ready"])).toBe(false);
    expect(deepLinkReady(["ready", "loading"])).toBe(false);
    expect(deepLinkReady(["ready", "empty", "error"])).toBe(true);
    expect(deepLinkReady([])).toBe(true);
  });
});
