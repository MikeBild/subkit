import { readFile } from "node:fs/promises";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import Fuse from "fuse.js";
import type {
  ConnectorTemplateCreateBody,
  RecipePackVertical,
} from "../engine-client/connectors.ts";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

const TEMPLATE_DRIVERS = [
  "http",
  "postgres",
  "s3",
  "graphql",
  "mcp",
] as const satisfies readonly ConnectorTemplateCreateBody["driver"][];

const RECIPE_PACK_VERTICALS = [
  "revops",
  "customer-success",
  "finance",
  "data",
  "devops",
  "security",
  "marketing",
  "hr",
  "solutions",
] as const satisfies readonly RecipePackVertical[];

function oneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List connector templates" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listConnectorTemplates();
        emitList(!!args.json, ["id", "slug", "name", "driver", "source", "version"], items);
      },
      { json: Boolean(args.json) },
    );
  },
});

export function rankTemplates<T extends Record<string, unknown>>(
  items: T[],
  query: string,
  limit: number,
): Array<T & { score: number }> {
  const fuse = new Fuse(items, {
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
    keys: [
      { name: "slug", weight: 3 },
      { name: "name", weight: 3 },
      { name: "aliases", weight: 2 },
      { name: "keywords", weight: 2 },
      { name: "tags", weight: 1 },
      { name: "category", weight: 1 },
      { name: "description", weight: 1 },
    ],
  });
  return fuse
    .search(query)
    .slice(0, limit)
    .map((r) => ({ ...r.item, score: Number((1 - (r.score ?? 0)).toFixed(2)) }));
}

const searchCommand = defineCommand({
  meta: { name: "search", description: "Fuzzy-search connector templates by name/alias/keyword" },
  args: {
    query: { type: "positional", required: true, description: "Search text (e.g. 'hub')" },
    limit: { type: "string", description: "Max results", default: "10" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listConnectorTemplates();
        const ranked = rankTemplates(items, String(args.query), Number(args.limit));
        if (ranked.length === 0 && !args.json) {
          process.stderr.write(
            `no templates match '${args.query}' — browse the full catalog with: sk connector-templates list\n`,
          );
        }
        emitList(!!args.json, ["slug", "name", "driver", "category", "score"], ranked);
      },
      { json: Boolean(args.json) },
    );
  },
});

export async function loadTemplateBodyFromArgs(
  args: Record<string, unknown>,
): Promise<ConnectorTemplateCreateBody> {
  const file = typeof args.file === "string" ? args.file : "";
  if (file) {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as ConnectorTemplateCreateBody;
  }
  const slug = String(args.slug ?? "");
  const name = String(args.name ?? "");
  const driver = String(args.driver ?? "");
  if (!slug || !name || !driver) {
    throw new Error("create requires either --file or --slug + --name + --driver");
  }
  if (!oneOf(TEMPLATE_DRIVERS, driver)) {
    throw new Error(`--driver must be one of: ${TEMPLATE_DRIVERS.join(" | ")}`);
  }
  return {
    version: 1,
    slug,
    name,
    driver,
    base_url: `https://${slug}.example.com`,
    auth_type: "none",
    oauth: null,
    default_skill: null,
    ingestion_source: "unsupported",
    ingestion_url: null,
    icon: "",
    description: `Connector template for ${name}.`,
    category: "custom",
    tags: [],
    aliases: [],
    setup_instructions: `Provide credentials to connect to ${name}.`,
    auth_options: [
      {
        auth_type: "none",
        label: "No Auth",
        description: "No authentication required.",
        oauth: null,
      },
    ],
    url_pattern: "^https?://",
    keywords: [],
    inline_schema: null,
    probe_endpoint: null,
    read_operations: [],
    resource_url_parser: null,
    credential_hints: [],
    base_url_options: [],
    pagination_defaults: null,
    capabilities: {
      webhooks: false,
      webhook_events: [],
      rate_limits: null,
    },
    example_paths: [],
    recipes: [],
    aws_service: null,
    aws_region: null,
    verified_at: null,
    respects_robots: false,
  };
}

const createCommand = defineCommand({
  meta: { name: "create", description: "Create a connector template" },
  args: {
    file: { type: "string", description: "Path to a full template JSON file" },
    slug: { type: "string", description: "Template slug (short-form convenience mode)" },
    name: { type: "string", description: "Template name (short-form convenience mode)" },
    driver: { type: "string", description: "Driver identifier (short-form convenience mode)" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.createConnectorTemplate(await loadTemplateBodyFromArgs(args)));
    });
  },
});

const setOauthCommand = defineCommand({
  meta: {
    name: "set-oauth",
    description: "Store tenant-scoped OAuth client credentials for a connector template",
  },
  args: {
    slug: { type: "string", required: true, description: "Template slug" },
    "client-id": { type: "string", required: true, description: "OAuth client id" },
    "client-secret": { type: "string", required: true, description: "OAuth client secret" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(
        await client.setConnectorTemplateOAuthCredentials(String(args.slug), {
          client_id: String(args["client-id"]),
          client_secret: String(args["client-secret"]),
        }),
      );
    });
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a connector template" },
  args: {
    id: { type: "positional", required: true, description: "Template id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.deleteConnectorTemplate(args.id);
      process.stdout.write("deleted\n");
    });
  },
});

const recipesListCommand = defineCommand({
  meta: { name: "recipes", description: "List recipes shipped with a connector template" },
  args: {
    slug: { type: "positional", description: "Template slug (e.g. stripe, github)" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const slug = String(args.slug ?? "");
    if (!slug) {
      process.stderr.write("recipes: --slug is required\n");
      process.exit(2);
    }
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { recipes } = await client.listConnectorTemplateRecipes(slug);
        if (args.json) {
          printJson(recipes);
          return;
        }
        emitList(false, ["slug", "title", "category", "difficulty", "version"], recipes);
      },
      { json: Boolean(args.json) },
    );
  },
});

const recipeShowCommand = defineCommand({
  meta: { name: "recipe", description: "Show one recipe by slug (template slug + recipe slug)" },
  args: {
    slug: { type: "positional", description: "Template slug (e.g. stripe)" },
    recipe: { type: "positional", description: "Recipe slug (e.g. list-customers)" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const slug = String(args.slug ?? "");
    const recipe = String(args.recipe ?? "");
    if (!slug || !recipe) {
      process.stderr.write("recipe: positional <slug> <recipe> are required\n");
      process.exit(2);
    }
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const r = await client.getConnectorTemplateRecipe(slug, recipe);
        if (args.json) {
          printJson(r);
          return;
        }
        const wf: { steps?: unknown; trigger?: unknown } = r.workflow ?? {};
        const stepCount = Array.isArray(wf.steps) ? wf.steps.length : 0;
        process.stdout.write(`recipe ${slug}/${r.slug}\n`);
        process.stdout.write(`  title:        ${r.title}\n`);
        process.stdout.write(`  description:  ${r.description}\n`);
        process.stdout.write(
          `  category:     ${r.category}  difficulty: ${r.difficulty}  version: ${r.version}\n`,
        );
        process.stdout.write(
          `  tags:         ${r.tags.length > 0 ? r.tags.join(", ") : "(none)"}\n`,
        );
        process.stdout.write(`  intent_keywords: ${r.intent_keywords.join(", ")}\n`);
        const prereqs = r.prerequisites;
        if (prereqs.length > 0) {
          process.stdout.write(`  prerequisites:\n`);
          for (const p of prereqs) process.stdout.write(`    - ${p}\n`);
        }
        process.stdout.write(`  step_count:   ${stepCount}\n`);
        const trigger = wf.trigger ?? null;
        if (trigger && typeof trigger === "object") {
          const kind = String((trigger as Record<string, unknown>).kind ?? "request");
          if (kind === "webhook") {
            const t = trigger as {
              source?: unknown;
              events?: unknown;
              verify?: unknown;
            };
            const source = typeof t.source === "string" ? t.source : "(unknown)";
            const events = Array.isArray(t.events)
              ? (t.events as unknown[]).map(String).join(", ")
              : "(any)";
            const verify = typeof t.verify === "string" ? t.verify : "(unknown)";
            process.stdout.write(`  trigger:\n`);
            process.stdout.write(`    kind:       webhook\n`);
            process.stdout.write(`    source:     ${source}\n`);
            process.stdout.write(`    events:     ${events.length > 0 ? events : "(any)"}\n`);
            process.stdout.write(`    verify:     ${verify}\n`);
          } else if (kind === "schedule") {
            const t = trigger as {
              cron?: unknown;
              tz?: unknown;
              business_days_only?: unknown;
              skip_dates?: unknown;
            };
            process.stdout.write(`  trigger:\n`);
            process.stdout.write(`    kind:       schedule\n`);
            process.stdout.write(
              `    cron:       ${typeof t.cron === "string" ? t.cron : "(unset)"}\n`,
            );
            process.stdout.write(`    tz:         ${typeof t.tz === "string" ? t.tz : "UTC"}\n`);
            if (t.business_days_only === true) {
              process.stdout.write(`    business_days_only: true\n`);
            }
            if (Array.isArray(t.skip_dates) && (t.skip_dates as unknown[]).length > 0) {
              process.stdout.write(
                `    skip_dates: ${(t.skip_dates as unknown[]).map(String).join(", ")}\n`,
              );
            }
          } else {
            process.stdout.write(`  trigger:      request (on-demand)\n`);
          }
        } else {
          process.stdout.write(`  trigger:      request (on-demand)\n`);
        }
      },
      { json: Boolean(args.json) },
    );
  },
});

const recipePackCommand = defineCommand({
  meta: { name: "recipe-pack", description: "Show the recipes in a vertical pack" },
  args: {
    vertical: {
      type: "positional",
      description:
        "Vertical (revops | customer-success | finance | data | devops | security | marketing | hr | solutions)",
    },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const vertical = String(args.vertical ?? "");
    if (!vertical) {
      process.stderr.write("recipe-pack: positional <vertical> is required\n");
      process.exit(2);
    }
    if (!oneOf(RECIPE_PACK_VERTICALS, vertical)) {
      process.stderr.write(
        `recipe-pack: unknown vertical '${vertical}' (${RECIPE_PACK_VERTICALS.join(" | ")})\n`,
      );
      process.exit(2);
    }
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const data = await client.getRecipePack(vertical);
        if (args.json) {
          printJson(data);
          return;
        }
        process.stdout.write(`recipe-pack ${data.vertical}\n  ${data.outcome}\n`);
        emitList(
          false,
          ["template_slug", "recipe_slug", "title", "category", "difficulty"],
          data.recipes,
        );
      },
      { json: Boolean(args.json) },
    );
  },
});

export const connectorTemplatesCommand = defineCommand({
  meta: { name: "connector-templates", description: "Manage connector templates" },
  subCommands: {
    list: listCommand,
    search: searchCommand,
    create: createCommand,
    "set-oauth": setOauthCommand,
    delete: deleteCommand,
    recipes: recipesListCommand,
    recipe: recipeShowCommand,
    "recipe-pack": recipePackCommand,
  },
});
