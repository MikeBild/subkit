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
