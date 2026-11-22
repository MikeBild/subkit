import { describe, expect, test } from "bun:test";
import { actorDirectory } from "@/app/actor-directory-model";
import { CATALOGS, type TranslationKey } from "@/lib/i18n";
import {
  API_ACCESS_ORDER,
  type ApiKeyItem,
  apiKeyCreatorLabel,
  apiKeyOwnerLabel,
  type ConnectedClientItem,
  calendarDaysUntil,
  connectedClientActiveSummary,
  connectedClientHistory,
  defaultKeyScopes,
  groupApiKeys,
  groupConnectedClients,
  KEY_EXPIRING_DAYS,
  keyIdleDays,
  keyPresetScopes,
  keyState,
  keyStateSaysUse,
  keyStateText,
  keysNeedingAction,
  openApiAccessSection,
  ROTATE_OVERLAP_MINUTES,
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
    creator: null,
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

describe("API key creator facts", () => {
  test("resolves typed people and accounts while preserving system and unknown fallbacks", () => {
    const directory = actorDirectory(
      { items: [{ id: "u1", email: "owner@example.test" }] },
      { items: [{ id: "s1", name: "Automation" }] },
    );
    expect(apiKeyCreatorLabel({ kind: "user", id: "u1" }, directory, t)).toBe("owner@example.test");
    expect(apiKeyCreatorLabel({ kind: "system_account", id: "s1" }, directory, t)).toBe(
      "Automation",
    );
    expect(apiKeyCreatorLabel({ kind: "system", id: null }, directory, t)).toBe("Engine");
    expect(apiKeyCreatorLabel({ kind: "user", id: "missing" }, directory, t)).toBe("Person");
    expect(apiKeyCreatorLabel(null, directory, t)).toBe("Unbekannt");
  });

  test("FactList owner and creator labels distinguish the issuing person from the key owner", () => {
    const directory = actorDirectory(
      {
        items: [
          { id: "user-a", email: "alice@example.test" },
          { id: "user-b", email: "bob@example.test" },
        ],
      },
      undefined,
    );
    const item = key({
      user_id: "user-b",
      creator: { kind: "user", id: "user-a" },
    });
    expect(apiKeyOwnerLabel(item, directory, t)).toBe("bob@example.test");
    expect(apiKeyCreatorLabel(item.creator, directory, t)).toBe("alice@example.test");
  });
});

describe("scope labels", () => {
  test("a scope reads as a name and a risk word, never as the raw string", () => {
    expect(scopeLabel("workflow:run", t)).toEqual({
      text: "Workflows · Starten",
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
    expect(scopeRisk("workflow:teleport")).toBe("writes");
  });

  test("the catalogue is what the person holds, wildcard first, reading before changing", () => {
    expect(
      scopeCatalogue(["rbac:write", "workflow:run", "workflow:read", "workflow:read"]),
    ).toEqual(["*", "workflow:read", "workflow:run", "rbac:write"]);
    expect(defaultKeyScopes(["workflow:read", "intake:read", "intake:write"])).toEqual([
      "workflow:read",
      "intake:read",
      "intake:write",
    ]);
  });
});

const daysAhead = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

describe("a key's state, on its row", () => {
  test("a working key used lately carries no word at all", () => {
    expect(keyState(key({}), NOW)).toBeNull();
    expect(keyState(key({ last_used_at: null, created_at: daysAgo(3) }), NOW)).toBeNull();
    expect(keyState(key({ expires_at: daysAhead(KEY_EXPIRING_DAYS + 1) }), NOW)).toBeNull();
  });

  test("the most pressing state wins, one per key", () => {
    expect(keyState(key({ expires_at: daysAgo(2), revoked_at: daysAgo(1) }), NOW)?.kind).toBe(
      "revoked",
    );
    expect(
      keyState(key({ expires_at: daysAgo(2), last_used_at: daysAgo(UNUSED_KEY_DAYS + 5) }), NOW)
        ?.kind,
    ).toBe("expired");
    expect(
      keyState(key({ expires_at: daysAhead(3), last_used_at: daysAgo(UNUSED_KEY_DAYS + 5) }), NOW),
    ).toEqual({ kind: "expiring", days: 3 });
  });

  test("an expiry within the window is counted in whole days, today and tomorrow by name", () => {
    const text = (expires: string) => {
      const state = keyState(key({ expires_at: expires }), NOW);
      return state ? keyStateText(state, t) : null;
    };
    expect(text(daysAhead(3))).toBe("Läuft in 3 Tagen ab");
    expect(text(daysAhead(KEY_EXPIRING_DAYS))).toBe(`Läuft in ${KEY_EXPIRING_DAYS} Tagen ab`);
    expect(text(daysAgo(2))).toBe("Abgelaufen");
    expect(text(new Date(NOW).toISOString())).toBe("Abgelaufen");
  });

  test("today and tomorrow are calendar days in the reader's zone, not 24-hour blocks", () => {
    const evening = new Date(2026, 8, 1, 23, 0).getTime();
    const chip = (expires: Date) => {
      const state = keyState(key({ expires_at: expires.toISOString() }), evening);
      return state ? keyStateText(state, t) : null;
    };
    expect(chip(new Date(2026, 8, 2, 1, 0))).toBe("Läuft morgen ab");
    expect(chip(new Date(2026, 8, 1, 23, 30))).toBe("Läuft heute ab");
    expect(chip(new Date(2026, 8, 3, 5, 0))).toBe("Läuft in 2 Tagen ab");
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
    expect(idle ? keyStateText(idle, t) : null).toBe(`Seit ${UNUSED_KEY_DAYS + 5} Tagen ungenutzt`);
    const never = keyState(key({ last_used_at: null, created_at: daysAgo(UNUSED_KEY_DAYS) }), NOW);
    expect(never).toEqual({ kind: "neverUsed", days: UNUSED_KEY_DAYS });
    expect(never ? keyStateText(never, t) : null).toBe(`Seit ${UNUSED_KEY_DAYS} Tagen nie benutzt`);
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
    last_used_at: null,
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    registration_source: "dcr",
    approved_by: ["anna@example.com"],
    connected_by: { grants: [], has_unknown_legacy: false },
    live_connections: 1,
    disabled_at: null,
    retired_at: null,
    created_at: daysAgo(30),
    ...overrides,
  };
}

describe("connected applications, in the order a reader needs them", () => {
  test("the list summary is bounded to the two newest active connections", () => {
    expect(
      connectedClientActiveSummary(
        {
          grants: [
            {
              user_id: "old",
              display_name: "Old Person",
              email: "old@example.com",
              connected_at: "2026-08-01T10:00:00.000Z",
              revoked_at: null,
            },
            {
              user_id: "old",
              display_name: "Old Person",
              email: "old@example.com",
              connected_at: "2026-07-01T10:00:00.000Z",
              revoked_at: null,
            },
            {
              user_id: "newest",
              display_name: "Newest Person",
              email: "newest@example.com",
              connected_at: "2026-10-01T10:00:00.000Z",
              revoked_at: null,
            },
            {
              user_id: "middle",
              display_name: null,
              email: "middle@example.com",
              connected_at: "2026-09-01T10:00:00.000Z",
              revoked_at: null,
            },
            {
              user_id: "revoked",
              display_name: "Revoked Person",
              email: "revoked@example.com",
              connected_at: "2026-10-02T10:00:00.000Z",
              revoked_at: "2026-10-03T10:00:00.000Z",
            },
          ],
          has_unknown_legacy: true,
        },
        t,
      ),
    ).toEqual({
      people: ["Newest Person", "middle@example.com"],
      moreCount: 1,
      hasUnknownLegacy: true,
    });
  });

  test("revoked-only history is excluded from the active summary", () => {
    expect(
      connectedClientActiveSummary(
        {
          grants: [
            {
              user_id: "revoked",
              display_name: "Revoked Person",
              email: "revoked@example.com",
              connected_at: "2026-10-02T10:00:00.000Z",
              revoked_at: "2026-10-03T10:00:00.000Z",
            },
          ],
          has_unknown_legacy: false,
        },
        t,
      ),
    ).toEqual({ people: [], moreCount: 0, hasUnknownLegacy: false });
  });

  test("legacy attribution stays separately unknown", () => {
    expect(connectedClientActiveSummary({ grants: [], has_unknown_legacy: true }, t)).toEqual({
      people: [],
      moreCount: 0,
      hasUnknownLegacy: true,
    });
  });

  test("connection history uses recorded names and times without exposing IDs", () => {
    const history = connectedClientHistory(
      {
        grants: [
          {
            user_id: "user-old",
            display_name: "   ",
            email: "old@example.com",
            connected_at: "2026-09-01T10:00:00.000Z",
            revoked_at: "2026-09-03T10:00:00.000Z",
          },
          {
            user_id: "user-current",
            display_name: "Ada Example",
            email: "ada@example.com",
            connected_at: "2026-10-01T10:00:00.000Z",
            revoked_at: null,
          },
          {
            user_id: "user-unknown",
            display_name: null,
            email: null,
            connected_at: "2026-08-01T10:00:00.000Z",
            revoked_at: null,
          },
        ],
        has_unknown_legacy: true,
      },
      t,
    );
    expect(history).toEqual([
      {
        person: "Ada Example",
        connectedAt: "2026-10-01T10:00:00.000Z",
        revokedAt: null,
        legacyUnknown: false,
      },
      {
        person: "old@example.com",
        connectedAt: "2026-09-01T10:00:00.000Z",
        revokedAt: "2026-09-03T10:00:00.000Z",
        legacyUnknown: false,
      },
      {
        person: "Unbekannte Person",
        connectedAt: "2026-08-01T10:00:00.000Z",
        revokedAt: null,
        legacyUnknown: false,
      },
      {
        person: "Historische Verbindung · Person unbekannt",
        connectedAt: null,
        revokedAt: null,
        legacyUnknown: true,
      },
    ]);
    expect(JSON.stringify(history)).not.toContain("user-current");
    expect(JSON.stringify(history)).not.toContain("user-old");
    expect(JSON.stringify(history)).not.toContain("user-unknown");
  });

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
    client({ id: "monitor", client_name: "Monitor", created_at: daysAgo(3) }),
  ];
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
    expect(groups.granted.map((item) => item.id)).toEqual(["monitor", "chatgpt", "claude"]);
  });

  test("registrations nobody holds a grant for are a group of their own", () => {
    const groups = groupConnectedClients(all);
    expect(groups.ungranted).toHaveLength(200);
    expect(groups.ungranted.every((item) => item.live_connections === 0)).toBe(true);
  });

  test("retired and revoked registrations are apart from both, whatever their grants", () => {
    const groups = groupConnectedClients(all);
    expect(groups.disabled).toHaveLength(31);
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

describe("the tabs: their order, the one that opens, and what they count", () => {
  test("keys first, then clients", () => {
    expect([...API_ACCESS_ORDER]).toEqual(["keys", "clients"]);
  });

  test("a section the reader may not read is absent, the order stays", () => {
    expect(readableSections({ keys: false, clients: true })).toEqual(["clients"]);
    expect(readableSections({ keys: false, clients: false })).toEqual([]);
  });

  test("the address picks the tab when the reader may read it, else the first one", () => {
    const all = readableSections({ keys: true, clients: true });
    expect(openApiAccessSection(null, all)).toBe("keys");
    expect(openApiAccessSection("clients", all)).toBe("clients");
    const noKeys = readableSections({ keys: false, clients: true });
    expect(openApiAccessSection("keys", noKeys)).toBe("clients");
    expect(openApiAccessSection("keys", [])).toBeNull();
  });

  test("a keys tab counts what needs a decision: expired and lapsing, not idle", () => {
    const items = [
      key({ expires_at: daysAgo(1) }),
      key({ expires_at: new Date(NOW + 3 * 86_400_000).toISOString() }),
      key({ last_used_at: daysAgo(200), created_at: daysAgo(300) }),
      key({}),
      key({ revoked_at: daysAgo(2), expires_at: daysAgo(1) }),
    ];
    expect(keysNeedingAction(items, NOW)).toBe(2);
  });
});

test("one app with access reads singular, more read plural — no (n)", () => {
  const { translate } = require("@/lib/i18n") as typeof import("@/lib/i18n");
  expect(translate("de", "connectedClients.live.one")).toBe("1 App mit Zugriff");
  expect(translate("de", "connectedClients.live", { count: "3" })).toBe("3 Apps mit Zugriff");
  expect(translate("de", "connectedClients.live", { count: "3" })).not.toContain("(n)");
});

test("key presets never grant permissions the issuer does not hold", () => {
  const held = [
    "workflow:read",
    "workflow:run",
    "intake:read",
    "intake:write",
    "rbac:write",
    "workflow:read",
  ];
  expect(keyPresetScopes("read", held)).toEqual(["workflow:read", "intake:read"]);
  expect(keyPresetScopes("run", held)).toEqual([
    "workflow:read",
    "workflow:run",
    "intake:read",
    "intake:write",
  ]);
  expect(keyPresetScopes("run", ["workflow:read", "workflow:run", "intake:read"])).toEqual([
    "workflow:read",
    "workflow:run",
    "intake:read",
  ]);
  expect(keyPresetScopes("manage", held)).toEqual([
    "workflow:read",
    "workflow:run",
    "intake:read",
    "intake:write",
    "rbac:write",
  ]);
  expect(keyPresetScopes("clipper", held)).toEqual(["intake:read", "intake:write"]);
  expect(keyPresetScopes("clipper", ["workflow:read", "intake:read"])).toEqual(["intake:read"]);
  expect(keyPresetScopes("manage", [])).toEqual([]);
  expect(keyPresetScopes("manage", ["*"])).toEqual([]);
  expect(ROTATE_OVERLAP_MINUTES).toBe(24 * 60);
});
