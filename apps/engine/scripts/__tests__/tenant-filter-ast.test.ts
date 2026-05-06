// Coverage for the AST-based tenant-filter audit. The CI gate replaces
// a regex heuristic that was loud and noisy (196 candidate sites, many
// false positives). These tests pin the AST scan's contract: which
// sites are real violations, which are not.

import { describe, expect, test } from "bun:test";
import { auditTenantFilterFromText } from "../audit/tenant-filter-ast.ts";

const SAFE_QUERY = `
import { eq } from "drizzle-orm";
import { conversations } from "../db/schema.ts";

declare const db: any;
declare const tenantId: string;
declare const conversationId: string;

export async function loadConvo() {
  return await db
    .select()
    .from(conversations)
    .where(eq(conversations.tenant_id, tenantId))
    .limit(1);
}
`;

const MISSING_TENANT_PREDICATE = `
import { eq } from "drizzle-orm";
import { conversations } from "../db/schema.ts";

declare const db: any;
declare const conversationId: string;

export async function loadConvo() {
  return await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
}
`;

const HELPER_INJECTED_TENANT = `
import { conversations } from "../db/schema.ts";

declare const db: any;
declare const filters: { tenant_id: string };

function buildTenantWhere(_f: { tenant_id: string }): unknown {
  return null;
}

export async function loadConvo() {
  return await db
    .select()
    .from(conversations)
    .where(buildTenantWhere(filters))
    .limit(1);
}
`;

const BUFFER_FROM_NOT_QUERY = `
declare const hex: string;

export function decode() {
  const buf = Buffer.from(hex, "hex");
  return buf;
}
`;

const ARRAY_FROM_NOT_QUERY = `
declare const set: Set<string>;

export function snapshot() {
  return Array.from(set);
}
`;

const SLUG_LOOKUP_WITH_EXEMPT = `
import { eq } from "drizzle-orm";
import { webhooksInbound } from "../db/schema.ts";

declare const db: any;
declare const slug: string;

export async function routeBySlug() {
  // tenant-filter:exempt — slug is globally unique; routes pre-tenant
  return await db
    .select()
    .from(webhooksInbound)
    .where(eq(webhooksInbound.slug, slug))
    .limit(1);
}
`;

const TRAILING_EXEMPT = `
import { eq } from "drizzle-orm";
import { apiKeys } from "../db/schema.ts";

declare const db: any;
declare const prefix: string;

export async function lookupKey() {
  return await db
    .select()
    .from(apiKeys) // tenant-filter:exempt — prefix lookup pre-tenant
    .where(eq(apiKeys.prefix, prefix))
    .limit(1);
}
`;

const ALLOWLISTED_TABLE = `
import { eq } from "drizzle-orm";
import { permissions } from "../db/schema.ts";

declare const db: any;

export async function loadPerms() {
  return await db.select().from(permissions);
}
`;

const TENANT_ID_VIA_PROPERTY_ACCESS = `
import { eq } from "drizzle-orm";
import { conversations } from "../db/schema.ts";

declare const db: any;
declare const ctx: { tenant_id: string };

export async function load() {
  return await db
    .select()
    .from(conversations)
    .where(eq(conversations.tenant_id, ctx.tenant_id));
}
`;

const TWO_QUERIES_ONE_SAFE_ONE_NOT = `
import { eq } from "drizzle-orm";
import { conversations, executions } from "../db/schema.ts";

declare const db: any;
declare const tenantId: string;
declare const wfId: string;

export async function load() {
  await db.select().from(conversations).where(eq(conversations.tenant_id, tenantId));
  await db.select().from(executions).where(eq(executions.workflow_id, wfId));
}
`;

const STRING_FROM_NOT_QUERY = `
export function trim(s: string) {
  return s.trim();
}

declare const arr: number[];

export function clone() {
  return [...arr].slice(0);
}
`;

describe("tenant-filter-ast", () => {
  test("safe query is not flagged", () => {
    expect(auditTenantFilterFromText(SAFE_QUERY)).toEqual([]);
  });

  test("missing tenant predicate is flagged", () => {
    const v = auditTenantFilterFromText(MISSING_TENANT_PREDICATE);
    expect(v).toHaveLength(1);
    expect(v[0]?.table).toBe("conversations");
  });

  test("helper-injected tenant is recognized via name heuristic", () => {
    expect(auditTenantFilterFromText(HELPER_INJECTED_TENANT)).toEqual([]);
  });

  test("Buffer.from is ignored (not a Drizzle query chain)", () => {
    expect(auditTenantFilterFromText(BUFFER_FROM_NOT_QUERY)).toEqual([]);
  });

  test("Array.from is ignored", () => {
    expect(auditTenantFilterFromText(ARRAY_FROM_NOT_QUERY)).toEqual([]);
  });

  test("leading exempt comment opts the site out", () => {
    expect(auditTenantFilterFromText(SLUG_LOOKUP_WITH_EXEMPT)).toEqual([]);
  });

  test("trailing exempt comment on the .from() line opts the site out", () => {
    expect(auditTenantFilterFromText(TRAILING_EXEMPT)).toEqual([]);
  });

  test("table allowlist suppresses the violation", () => {
    expect(
      auditTenantFilterFromText(ALLOWLISTED_TABLE, {
        tableAllowlist: new Set(["permissions"]),
      }),
    ).toEqual([]);
  });

  test("tenant_id via property-access argument is recognized", () => {
    expect(auditTenantFilterFromText(TENANT_ID_VIA_PROPERTY_ACCESS)).toEqual([]);
  });

  test("mixed file flags only the unsafe site", () => {
    const v = auditTenantFilterFromText(TWO_QUERIES_ONE_SAFE_ONE_NOT);
    expect(v).toHaveLength(1);
    expect(v[0]?.table).toBe("executions");
  });

  test("non-query .from-like surfaces are ignored", () => {
    expect(auditTenantFilterFromText(STRING_FROM_NOT_QUERY)).toEqual([]);
  });

  test("exempt comment placed beyond MAX_CHAIN_SCAN_LINES is NOT recognised (boundary pin)", () => {
    // Pins the upper bound of the mid-chain trivia scan
    // (MAX_CHAIN_SCAN_LINES = 12). An exempt comment 14 lines
    // above the .from() must NOT be treated as exempt — otherwise
    // a future raise of the constant could mask real violations
    // by accident. If a legitimate query needs the comment at
    // that distance, the constant should be raised deliberately
    // and this test updated.
    const text = `
import { eq } from "drizzle-orm";
import { conversations } from "../db/schema.ts";

declare const db: any;
declare const id: string;

export async function load() {
  const x =
    null ??
    // tenant-filter:exempt — far-away exempt that should NOT count
    (
      // padding line 1
      // padding line 2
      // padding line 3
      // padding line 4
      // padding line 5
      // padding line 6
      // padding line 7
      // padding line 8
      // padding line 9
      // padding line 10
      // padding line 11
      // padding line 12
      // padding line 13
      // padding line 14
      await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1)
    )[0];
  return x;
}
`;
    const v = auditTenantFilterFromText(text);
    expect(v).toHaveLength(1);
  });

  test("exempt comment with TODO/FIXME reason still flags the site", () => {
    const text = `
import { eq } from "drizzle-orm";
import { conversations } from "../db/schema.ts";

declare const db: any;
declare const id: string;

export async function load() {
  // tenant-filter:exempt — TODO(audit-2026-06): verify tenant scoping for this site
  return await db.select().from(conversations).where(eq(conversations.id, id));
}
`;
    const v = auditTenantFilterFromText(text);
    expect(v).toHaveLength(1);
  });

  test("exempt comment without a reason still flags the site", () => {
    const text = `
import { eq } from "drizzle-orm";
import { conversations } from "../db/schema.ts";

declare const db: any;
declare const id: string;

export async function load() {
  // tenant-filter:exempt
  return await db.select().from(conversations).where(eq(conversations.id, id));
}
`;
    const v = auditTenantFilterFromText(text);
    expect(v).toHaveLength(1);
  });

  test("tenantConds-style identifier in .where() is recognized as a tenant signal", () => {
    const text = `
import { and, eq } from "drizzle-orm";
import { connectors } from "../db/schema.ts";

declare const db: any;
declare const tenant_id: string;

export async function listConnectors() {
  const tenantConds = [eq(connectors.tenant_id, tenant_id)];
  return await db.select().from(connectors).where(and(...tenantConds));
}
`;
    expect(auditTenantFilterFromText(text)).toEqual([]);
  });

  test("exempt comment placed mid-chain (across continuation lines) is recognized", () => {
    const text = `
import { eq } from "drizzle-orm";
import { conversations } from "../db/schema.ts";

declare const db: any;
declare const id: string;

export async function load() {
  const x =
    null ??
    // tenant-filter:exempt — slug-based routing pre-tenant
    (
      await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1)
    )[0];
  return x;
}
`;
    expect(auditTenantFilterFromText(text)).toEqual([]);
  });
});
