// `sk connector-templates search` — pure ranking logic.

import { describe, expect, test } from "bun:test";
import { rankTemplates } from "../commands/connector-templates.ts";

const CATALOG: Record<string, unknown>[] = [
  {
    slug: "hubspot",
    name: "HubSpot",
    driver: "http",
    category: "crm",
    tags: ["crm", "sales"],
    aliases: ["hub spot"],
    keywords: ["contacts", "deals", "pipelines"],
    description: "HubSpot CRM REST API",
  },
  {
    slug: "github",
    name: "GitHub",
    driver: "http",
    category: "devtools",
    tags: ["git", "code"],
    aliases: ["gh"],
    keywords: ["repos", "issues", "pull requests"],
    description: "GitHub REST API",
  },
  {
    slug: "stripe",
    name: "Stripe",
    driver: "http",
    category: "payments",
    tags: ["billing"],
    aliases: [],
    keywords: ["charges", "invoices", "customers"],
    description: "Stripe payments API",
  },
  {
    slug: "postgres",
    name: "PostgreSQL",
    driver: "postgres",
    category: "database",
    tags: ["sql"],
    aliases: ["pg", "postgresql"],
    keywords: ["query", "tables"],
    description: "Direct Postgres access",
  },
];

describe("rankTemplates", () => {
  test("'hub' finds hubspot first", () => {
    const out = rankTemplates(CATALOG, "hub", 10);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.slug).toBe("hubspot");
  });

  test("alias match: 'pg' finds postgres", () => {
    const out = rankTemplates(CATALOG, "pg", 10);
    expect(out.some((r) => r.slug === "postgres")).toBe(true);
  });

  test("keyword match: 'invoices' finds stripe", () => {
    const out = rankTemplates(CATALOG, "invoices", 10);
    expect(out.some((r) => r.slug === "stripe")).toBe(true);
  });

  test("limit caps the result count", () => {
    const out = rankTemplates(CATALOG, "api", 1);
    expect(out.length).toBeLessThanOrEqual(1);
  });

  test("rows carry a normalized score in (0, 1]", () => {
    const out = rankTemplates(CATALOG, "hubspot", 10);
    for (const row of out) {
      expect(typeof row.score).toBe("number");
      expect(row.score as number).toBeGreaterThan(0);
      expect(row.score as number).toBeLessThanOrEqual(1);
    }
  });

  test("nonsense query returns empty", () => {
    expect(rankTemplates(CATALOG, "zzzzqqqq", 10)).toEqual([]);
  });
});
