#!/usr/bin/env bun

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ContractFixture,
  checkTemplateContract,
  scaffoldTemplateContract,
} from "../apps/engine/src/connectors/core/contract.ts";
import {
  type ConnectorTemplate,
  ConnectorTemplateSchema,
  getBuiltinTemplate,
} from "../apps/engine/src/connectors/templates.ts";

export const SCAFFOLD_DRIVERS = ["http", "graphql", "postgres", "s3", "mcp"] as const;
export type ScaffoldDriver = (typeof SCAFFOLD_DRIVERS)[number];

const CONTRACTS = join(import.meta.dir, "..", "apps/engine/src/connectors/contracts");
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const USAGE = `usage: bun run gen connector <slug> [--driver ${SCAFFOLD_DRIVERS.join("|")}]`;

export interface ConnectorScaffold {
  template: ConnectorTemplate;
  fixture: ContractFixture;
  inventory_pin: string;
  existing: boolean;
}

function titleOf(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function addressOf(slug: string, driver: ScaffoldDriver) {
  switch (driver) {
    case "http":
      return { base_url: `https://api.${slug}.example.com`, url_pattern: null };
    case "graphql":
      return { base_url: `https://api.${slug}.example.com/graphql`, url_pattern: null };
    case "mcp":
      return { base_url: `https://mcp.${slug}.example.com/mcp`, url_pattern: null };
    case "s3":
      return { base_url: `https://s3.${slug}.example.com`, url_pattern: null };
    case "postgres":
      return { base_url: "", url_pattern: "^postgres(ql)?:\\/\\/" };
  }
}

function hint(field: string, label: string, secret: boolean) {
  return { field, label, placeholder: "", doc_url: null, secret };
}

export function templateStub(slug: string, driver: ScaffoldDriver): ConnectorTemplate {
  const sends = driver === "http" || driver === "graphql";
  return ConnectorTemplateSchema.parse({
    version: 1,
    slug,
    name: titleOf(slug),
    driver,
    ...addressOf(slug, driver),
    auth_type: sends ? "bearer" : "none",
    oauth: null,
    default_skill: null,
    ingestion_source: driver === "graphql" ? "graphql" : driver === "postgres" ? "postgres" : null,
    ingestion_url: null,
    icon: `${slug}.svg`,
    description: `${titleOf(slug)} API`,
    category: "other",
    tags: [],
    setup_instructions: `Create an API token for ${titleOf(slug)} and paste it here.`,
    auth_options: sends
      ? [
          {
            auth_type: "bearer",
            label: "Bearer token",
            description: "Authenticate with a bearer token sent in the Authorization header.",
          },
        ]
      : [],
    keywords: [],
    inline_schema: null,
    probe_endpoint: null,
    credential_hints: sends
      ? [hint("token", "API Bearer Token", true)]
      : driver === "postgres"
        ? [hint("username", "Postgres user", false), hint("password", "Postgres password", true)]
        : [],
    base_url_options: [],
    pagination_defaults: null,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
    aws_service: null,
    aws_region: null,
    verified_at: null,
  });
}

export function connectorScaffold(slug: string, driver: ScaffoldDriver): ConnectorScaffold {
  const builtin = getBuiltinTemplate(slug);
  const template = builtin ?? templateStub(slug, driver);
  const pin = { version: template.version, capabilities: template.capabilities };
  return {
    template,
    fixture: scaffoldTemplateContract(template),
    inventory_pin: `${JSON.stringify(slug)}: ${JSON.stringify(pin, null, 2)},`,
    existing: builtin !== null,
  };
}

export function parseScaffoldArgs(
  argv: readonly string[],
): { slug: string; driver: ScaffoldDriver } | null {
  const [slug, ...rest] = argv;
  if (!slug || !SLUG_RE.test(slug)) return null;
  if (rest.length === 0) return { slug, driver: "http" };
  const [flag, driver] = rest;
  if (rest.length !== 2 || flag !== "--driver") return null;
  return (SCAFFOLD_DRIVERS as readonly string[]).includes(driver ?? "")
    ? { slug, driver: driver as ScaffoldDriver }
    : null;
}

function main(argv: readonly string[]): number {
  const args = parseScaffoldArgs(argv);
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  const target = join(CONTRACTS, `${args.slug}.json`);
  if (existsSync(target)) {
    console.error(`contract fixture already exists: ${target}`);
    return 1;
  }
  const scaffold = connectorScaffold(args.slug, args.driver);
  const issues = checkTemplateContract(scaffold.template, scaffold.fixture);
  writeFileSync(target, `${JSON.stringify(scaffold.fixture, null, 2)}\n`);
  console.error(`wrote ${target}`);
  for (const entry of issues)
    console.error(`fix before committing — ${entry.code}: ${entry.message}`);
  if (scaffold.existing) return 0;
  console.error("\nadd this template to apps/engine/src/connectors/templates.json:\n");
  console.log(JSON.stringify(scaffold.template, null, 2));
  console.error(
    "\nadd this pin to EXPECTED_INVENTORY in apps/engine/src/connectors/templates-inventory.test.ts:\n",
  );
  console.log(scaffold.inventory_pin);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
