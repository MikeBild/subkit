import { describe, expect, test } from "bun:test";
import { CATALOGS, type TranslationKey } from "@/lib/i18n";
import {
  type ApiKeyItem,
  apiAccessAttention,
  defaultKeyScopes,
  keyIdleDays,
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
