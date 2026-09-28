import { describe, expect, test } from "bun:test";
import { CATALOGS, type TranslationKey } from "@/lib/i18n";
import {
  API_ACCESS_ORDER,
  type ApiKeyItem,
  type ConnectedClientItem,
  calendarDaysUntil,
  deepLinkReady,
  defaultKeyScopes,
  groupApiKeys,
  groupConnectedClients,
  KEY_EXPIRING_DAYS,
  keyIdleDays,
  keyState,
  keyStateSaysUse,
  keyStateText,
  readableSections,
  scopeCatalogue,
  scopeLabel,
  scopeRisk,
  UNUSED_KEY_DAYS,
} from "./api-access-model";

const DE = CATALOGS.de;
const t = (key: TranslationKey, values: Record<string, string | number> = {}) =>
  Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    DE[key],
  );

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

const daysAhead = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

describe("a key's state, on its row", () => {
  test("a working key used lately carries no word at all", () => {
    expect(keyState(key({}), NOW)).toBeNull();
    // Freshly made and not used yet: its use line already says so.
    expect(keyState(key({ last_used_at: null, created_at: daysAgo(3) }), NOW)).toBeNull();
    // An expiry far enough away is not news either.
    expect(keyState(key({ expires_at: daysAhead(KEY_EXPIRING_DAYS + 1) }), NOW)).toBeNull();
  });

  test("the most pressing state wins, one per key", () => {
    // Revoked and expired: revoked, it holds nothing any more.
    expect(keyState(key({ expires_at: daysAgo(2), revoked_at: daysAgo(1) }), NOW)?.kind).toBe(
      "revoked",
    );
    // Expired and idle for months: expired.
    expect(
      keyState(key({ expires_at: daysAgo(2), last_used_at: daysAgo(UNUSED_KEY_DAYS + 5) }), NOW)
        ?.kind,
    ).toBe("expired");
    // About to lapse and idle: the lapse.
    expect(
      keyState(key({ expires_at: daysAhead(3), last_used_at: daysAgo(UNUSED_KEY_DAYS + 5) }), NOW),
    ).toEqual({ kind: "expiring", days: 3 });
  });

  test("an expiry within the window is counted in whole days, today and tomorrow by name", () => {
    const text = (expires: string) => {
      const state = keyState(key({ expires_at: expires }), NOW);
      return state ? keyStateText(state, t) : null;
    };
    expect(text(daysAhead(3))).toBe("läuft ab in 3 Tagen");
    expect(text(daysAhead(KEY_EXPIRING_DAYS))).toBe(`läuft ab in ${KEY_EXPIRING_DAYS} Tagen`);
    expect(text(daysAgo(2))).toBe("abgelaufen");
    expect(text(new Date(NOW).toISOString())).toBe("abgelaufen");
  });

  test("today and tomorrow are calendar days in the reader's zone, not 24-hour blocks", () => {
    // Late in the evening, local time: a key lapsing two hours later lapses
    // TOMORROW, one lapsing within the hour lapses today.
    const evening = new Date(2026, 8, 1, 23, 0).getTime();
    const chip = (expires: Date) => {
      const state = keyState(key({ expires_at: expires.toISOString() }), evening);
      return state ? keyStateText(state, t) : null;
    };
    expect(chip(new Date(2026, 8, 2, 1, 0))).toBe("läuft morgen ab");
    expect(chip(new Date(2026, 8, 1, 23, 30))).toBe("läuft heute ab");
    // Thirty hours away, but two dates on: in two days.
    expect(chip(new Date(2026, 8, 3, 5, 0))).toBe("läuft ab in 2 Tagen");
    expect(calendarDaysUntil(new Date(2026, 8, 2, 0, 1).getTime(), evening)).toBe(1);
  });

  test("a chip that says how the key was used replaces the use line's own words", () => {
    expect(keyStateSaysUse({ kind: "idle", days: 120 })).toBe(true);
    expect(keyStateSaysUse({ kind: "neverUsed", days: 95 })).toBe(true);
    expect(keyStateSaysUse({ kind: "expiring", days: 3 })).toBe(false);
    expect(keyStateSaysUse({ kind: "expired" })).toBe(false);
    expect(keyStateSaysUse(null)).toBe(false);
  });

  test("a key idle past the threshold says since when, used or never", () => {
    const idle = keyState(key({ last_used_at: daysAgo(UNUSED_KEY_DAYS + 5) }), NOW);
    expect(idle).toEqual({ kind: "idle", days: UNUSED_KEY_DAYS + 5 });
    expect(idle ? keyStateText(idle, t) : null).toBe(`seit ${UNUSED_KEY_DAYS + 5} Tagen ungenutzt`);
    const never = keyState(key({ last_used_at: null, created_at: daysAgo(UNUSED_KEY_DAYS) }), NOW);
    expect(never).toEqual({ kind: "neverUsed", days: UNUSED_KEY_DAYS });
    expect(never ? keyStateText(never, t) : null).toBe(`seit ${UNUSED_KEY_DAYS} Tagen nie benutzt`);
    // One day short of the threshold is still a working key.
    expect(keyState(key({ last_used_at: daysAgo(UNUSED_KEY_DAYS - 1) }), NOW)).toBeNull();
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
