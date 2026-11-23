import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateConnectorConfig } from "./config-schemas.ts";
import {
  contractExchangeCredential,
  observeContractExchange,
} from "./contracts/exchange-fixtures.ts";
import {
  type ContractIssueCode,
  checkContractExchange,
  checkTemplateContract,
  contractBaseUrl,
  contractKind,
  ExchangeContractSchema,
  SchemaContractSchema,
} from "./core/contract.ts";
import { loadBuiltinTemplates } from "./templates.ts";

const CONTRACTS = join(import.meta.dir, "contracts");
const templates = loadBuiltinTemplates();

const KNOWN_GAPS: Readonly<Record<string, readonly ContractIssueCode[]>> = {};

function readFixture(slug: string): unknown {
  return JSON.parse(readFileSync(join(CONTRACTS, `${slug}.json`), "utf8"));
}

describe("connector template contracts", () => {
  test("every builtin template has a contract fixture and every fixture has a template", () => {
    const missing = templates
      .map((template) => template.slug)
      .filter((slug) => !existsSync(join(CONTRACTS, `${slug}.json`)));
    expect(missing).toEqual([]);
    const known = new Set(templates.map((template) => template.slug));
    const orphans = readdirSync(CONTRACTS)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length))
      .filter((slug) => !known.has(slug));
    expect(orphans).toEqual([]);
  });

  test("the known gaps name builtin templates only", () => {
    const known = new Set(templates.map((template) => template.slug));
    expect(Object.keys(KNOWN_GAPS).filter((slug) => !known.has(slug))).toEqual([]);
  });

  for (const template of templates) {
    test(`${template.slug} (${template.driver}) keeps its contract`, async () => {
      const fixture = readFixture(template.slug);
      const issues = checkTemplateContract(template, fixture);
      const parsed = ExchangeContractSchema.safeParse(fixture);
      if (contractKind(template.driver) === "exchange" && parsed.success) {
        const exchange = parsed.data;
        const observed = await observeContractExchange(template, exchange);
        const home = new URL(contractBaseUrl(template, exchange) ?? "").host;
        expect(observed.requests.map((request) => new URL(request.url).host)).toEqual([home]);
        issues.push(
          ...checkContractExchange(
            template,
            exchange,
            observed,
            contractExchangeCredential(template, exchange),
          ),
        );
      }
      const schema = SchemaContractSchema.safeParse(fixture);
      if (contractKind(template.driver) === "schema" && schema.success) {
        expect(validateConnectorConfig(template.driver, schema.data.connector.config)).toEqual([]);
      }
      expect(issues.filter((entry) => !KNOWN_GAPS[template.slug]?.includes(entry.code))).toEqual(
        [],
      );
      expect(issues.map((entry) => entry.code).sort()).toEqual(
        [...(KNOWN_GAPS[template.slug] ?? [])].sort(),
      );
    });
  }
});
