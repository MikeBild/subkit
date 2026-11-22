import type { SubkitBootstrapSnapshot } from "../../lib/bootstrap.ts";

type PersonaFixture = "admin" | "operator" | "member" | "enduser" | "portal";

const ADMIN_PERMS = [
  "conversation:read",
  "conversation:write",
  "memory:write",
  "conversation:approve",
  "conversation:list",
  "mcp:read",
  "skill:read",
  "conversation:cancel",
  "conversation:commit",
  "workflow:read",
  "workflow:write",
  "connector:read",
  "skill:write",
  "execution:read",
  "notification:read",
  "audit:read",
  "identity:read",
  "rbac:read",
  "api_key:read",
  "portal_token:read",
  "knowledge:read",
];

const OPERATOR_PERMS = ADMIN_PERMS.filter(
  (p) =>
    !["audit:read", "identity:read", "rbac:read", "api_key:read", "portal_token:read"].includes(p),
);

const MEMBER_PERMS = [
  "conversation:read",
  "conversation:write",
  "memory:write",
  "conversation:approve",
  "conversation:list",
  "mcp:read",
  "skill:read",
];

const ENDUSER_PERMS = ["conversation:read", "conversation:write", "memory:write"];
const PORTAL_PERMS = ["conversation:write", "memory:write"];

const TABLE: Record<PersonaFixture, string[]> = {
  admin: ADMIN_PERMS,
  operator: OPERATOR_PERMS,
  member: MEMBER_PERMS,
  enduser: ENDUSER_PERMS,
  portal: PORTAL_PERMS,
};

export function bootstrapFixture(persona: PersonaFixture): SubkitBootstrapSnapshot {
  const perms = TABLE[persona] ?? [];
  const allowed = new Set(perms);
  return {
    label: persona,
    allowed,
    probe: { allows: (p: string) => allowed.has(p) },
    tenant: "t-fixture",
    email: `${persona}@fixture.local`,
    recentSessions: [],
    flags: {},
    prefs: {
      theme: "auto",
      personality: "balanced",
      titleFormat: "session-id",
      statuslineFormat: "compact",
      pushNotifyEnabled: false,
      pushNotifyThresholdSec: 30,
      quietHoursStart: "",
      quietHoursEnd: "",
      portalTokenTtlMin: 15,
    },
    fetchedAt: 1_700_000_000_000,
    source: "network",
  };
}

export function permissionsFor(persona: PersonaFixture): readonly string[] {
  return TABLE[persona] ?? [];
}
