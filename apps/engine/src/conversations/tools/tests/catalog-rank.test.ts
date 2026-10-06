import { describe, expect, test } from "bun:test";
import { isListAllQuery, rankCatalog, rankTokens } from "../catalog-rank.ts";

interface Entry {
  slug: string;
  name: string;
  category: string;
  description: string | null;
  detail?: string[];
}

const catalog: Entry[] = [
  ...["daily", "weekly", "monthly", "yearly"].map((period) => ({
    slug: `acme-rollup-${period}`,
    name: `Acme ${period} rollup`,
    category: "acme-reporting",
    description: `Rolls the ${period} figures into one report for the operations team.`,
  })),
  {
    slug: "growth-weekly",
    name: "Growth weekly",
    category: "acme-reporting",
    description: "Collects weekly traffic and search figures and publishes the growth report.",
  },
  {
    slug: "server-daily-digest",
    name: "Server daily digest",
    category: "other",
    description: "Mails the daily server costs and droplet usage.",
  },
  {
    slug: "invoice-attachments",
    name: "List invoice attachments",
    category: "billing",
    description: "Finds mails from the vendor that carry invoice PDFs.",
    detail: ["mail-api"],
  },
  {
    slug: "card-checkout-access",
    name: "Card checkout to access",
    category: "billing",
    description: null,
    detail: ["payments-api", "content-admin"],
  },
  {
    slug: "pages-search",
    name: "Search pages",
    category: "knowledge-pages",
    description: "Searches the team wiki for pages matching a query.",
  },
];

const fields = (e: Entry) => ({
  category: [e.category],
  identity: [e.slug, e.name],
  description: [e.description],
  ...(e.detail ? { detail: e.detail } : {}),
});

const top = (query: string, n = 3) =>
  rankCatalog(query, catalog, fields)
    .slice(0, n)
    .map((r) => r.item.slug);

describe("rankCatalog", () => {
  test("a description-only hit is found even when slug and category say nothing", () => {
    expect(top("droplet costs", 1)).toEqual(["server-daily-digest"]);
  });

  test("the category outranks a passing mention in a description", () => {
    const ranked = top("billing", 5);
    expect(ranked.slice(0, 2).sort()).toEqual(["card-checkout-access", "invoice-attachments"]);
  });

  test("German stopwords and inflections do not drown the signal", () => {
    expect(top("Zeig mir die Rechnungen mit invoice Anhängen", 1)).toEqual(["invoice-attachments"]);
    expect(top("welche workflows durchsuchen das wiki", 1)).toEqual(["pages-search"]);
  });

  test("an inflected term still meets its stem", () => {
    expect(top("searching pages", 1)).toEqual(["pages-search"]);
    expect(top("rollups", 4).every((slug) => slug.startsWith("acme-rollup-"))).toBe(true);
  });

  test("every match says why it matched", () => {
    const [first] = rankCatalog("weekly growth report", catalog, fields);
    expect(first?.item.slug).toBe("growth-weekly");
    expect(first?.reasons.map((r) => `${r.field}:${r.term}`)).toEqual([
      "identity:weekly",
      "identity:growth",
      "category:report",
    ]);
  });

  test("a query of only filler words matches nothing instead of everything", () => {
    expect(rankCatalog("zeig mir alle workflows", catalog, fields)).toEqual([]);
    expect(rankCatalog("unrelated quantum", catalog, fields)).toEqual([]);
  });

  test("ties keep catalog order, so the ranking is deterministic", () => {
    const first = rankCatalog("rollup", catalog, fields).map((r) => r.item.slug);
    const second = rankCatalog("rollup", catalog, fields).map((r) => r.item.slug);
    expect(first).toEqual(second);
    expect(first.slice(0, 4)).toEqual([
      "acme-rollup-daily",
      "acme-rollup-weekly",
      "acme-rollup-monthly",
      "acme-rollup-yearly",
    ]);
  });
});

describe("rankTokens and list-all", () => {
  test("folds accents and drops filler", () => {
    expect(rankTokens("Zeige die Übersicht für März")).toEqual(["ubersicht", "marz"]);
  });

  test("recognises the explicit list-all spellings", () => {
    expect(isListAllQuery("*")).toBe(true);
    expect(isListAllQuery(undefined)).toBe(true);
    expect(isListAllQuery("alle")).toBe(true);
    expect(isListAllQuery("reports")).toBe(false);
  });
});
