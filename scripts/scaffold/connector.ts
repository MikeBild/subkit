#!/usr/bin/env bun
// Append a new connector template to apps/engine/src/connectors/templates.json
// with a safe default shape so the new row is valid against the existing
// schema. The 90th template is just one more row; keep this tool
// dumb — it does not invent OAuth endpoints or ingestion URLs.
//
// Usage:
//   bun run scripts/scaffold/connector.ts <slug> <display-name> <driver>
//
// Example:
//   bun run scripts/scaffold/connector.ts linear "Linear" http
// Adds:
//   {
//     "slug": "linear",
//     "name": "Linear",
//     "driver": "http",
//     "auth_type": "bearer",
//     ...
//   }
//
// Fill the base_url, ingestion_url, setup_hint, and category manually.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const TEMPLATES_PATH = path.join(ROOT, "apps/engine/src/connectors/templates.json");

function usage(): never {
  console.error(
    "usage: bun run scripts/scaffold/connector.ts <slug> <display-name> <http|graphql|postgres|s3>",
  );
  process.exit(2);
}

const [, , slug, displayName, driver] = process.argv;
if (!slug || !displayName || !driver) usage();
if (!/^[a-z][a-z0-9-]*$/.test(slug)) usage();
if (!["http", "graphql", "postgres", "s3"].includes(driver)) usage();

type Template = {
  slug: string;
  name: string;
  driver: string;
  base_url?: string | null;
  auth_type: string;
  oauth: unknown;
  default_skill: string | null;
  ingestion_source: string | null;
  ingestion_url: string | null;
  icon: string | null;
  description: string;
  category: string;
  tags: string[];
  setup_hint: string;
  auth_options: unknown[];
};

const raw = readFileSync(TEMPLATES_PATH, "utf8");
const templates = JSON.parse(raw) as Template[];

if (templates.some((t) => t.slug === slug)) {
  console.error(`connector slug "${slug}" already exists in templates.json`);
  process.exit(1);
}

const template: Template = {
  slug,
  name: displayName,
  driver,
  base_url: driver === "http" || driver === "graphql" ? "https://api.example.com" : null,
  auth_type: driver === "http" ? "bearer" : "none",
  oauth: null,
  default_skill: null,
  ingestion_source: driver === "http" ? "openapi" : null,
  ingestion_url: null,
  icon: null,
  description: `TODO: one-sentence description of ${displayName}.`,
  category: "other",
  tags: [driver === "http" ? "rest" : driver],
  setup_hint: `TODO: setup instructions for ${displayName}.`,
  auth_options: [],
};

templates.push(template);

writeFileSync(TEMPLATES_PATH, `${JSON.stringify(templates, null, 2)}\n`);

console.log(`added ${slug} → ${path.relative(ROOT, TEMPLATES_PATH)}`);
console.log("\nnext steps:");
console.log("  1. fill in base_url, ingestion_url, setup_hint, description");
console.log("  2. (optional) add a default_skill to template-skills.json");
console.log("  3. bun run test:integration");
