import { readFile } from "node:fs/promises";
import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

function makeClient() {
  const profile = resolveProfile();
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List connector templates" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listConnectorTemplates();
      emitList(!!args.json, ["id", "slug", "name", "driver", "source", "version"], items);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

async function loadTemplateBodyFromArgs(args: Record<string, unknown>) {
  const file = typeof args.file === "string" ? args.file : "";
  if (file) {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  }
  const slug = String(args.slug ?? "");
  const name = String(args.name ?? "");
  const driver = String(args.driver ?? "");
  if (!slug || !name || !driver) {
    throw new Error("create requires either --file or --slug + --name + --driver");
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
    credential_hints: [],
    base_url_options: [],
    pagination_defaults: null,
    capabilities: {
      webhooks: false,
      webhook_events: [],
      rate_limits: null,
    },
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
    try {
      printJson(await client.createConnectorTemplate(await loadTemplateBodyFromArgs(args)));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
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
    try {
      printJson(
        await client.setConnectorTemplateOAuthCredentials(String(args.slug), {
          client_id: String(args["client-id"]),
          client_secret: String(args["client-secret"]),
        }),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a connector template" },
  args: {
    id: { type: "positional", required: true, description: "Template id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.deleteConnectorTemplate(args.id);
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

// Workstream E3 — recipe browse subcommands. Mirror the conversation
// tools (`start_workflow_from_recipe`, `inspect_recipe`) and the MCP
// tools (`list_recipes`, `inspect_recipe`) so the CLI is the third
// equivalent surface per the chat-CLI parity rule in
// `apps/sk/AGENTS.md`.

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
    try {
      const { recipes } = await client.listConnectorTemplateRecipes(slug);
      if (args.json) {
        printJson(recipes);
        return;
      }
      emitList(false, ["slug", "title", "category", "difficulty", "version"], recipes);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
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
    try {
      const data = await client.getConnectorTemplateRecipe(slug, recipe);
      if (args.json) {
        printJson(data);
        return;
      }
      // Pretty: header + key fields + step summary line count.
      const r = data as Record<string, unknown>;
      const wf = (r.workflow as { steps?: unknown[] }) ?? {};
      const stepCount = Array.isArray(wf.steps) ? wf.steps.length : 0;
      process.stdout.write(`recipe ${slug}/${r.slug}\n`);
      process.stdout.write(`  title:        ${r.title}\n`);
      process.stdout.write(`  description:  ${r.description}\n`);
      process.stdout.write(
        `  category:     ${r.category}  difficulty: ${r.difficulty}  version: ${r.version}\n`,
      );
      process.stdout.write(
        `  tags:         ${Array.isArray(r.tags) && r.tags.length > 0 ? (r.tags as string[]).join(", ") : "(none)"}\n`,
      );
      process.stdout.write(
        `  intent_keywords: ${(r.intent_keywords as string[] | undefined)?.join(", ") ?? "(none)"}\n`,
      );
      const prereqs = r.prerequisites as string[] | undefined;
      if (prereqs && prereqs.length > 0) {
        process.stdout.write(`  prerequisites:\n`);
        for (const p of prereqs) process.stdout.write(`    - ${p}\n`);
      }
      process.stdout.write(`  step_count:   ${stepCount}\n`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const recipePackCommand = defineCommand({
  meta: { name: "recipe-pack", description: "Show the recipes in a vertical pack" },
  args: {
    vertical: {
      type: "positional",
      description:
        "Vertical (revops | customer-success | finance | data | devops | security | marketing | hr)",
    },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const vertical = String(args.vertical ?? "");
    if (!vertical) {
      process.stderr.write("recipe-pack: positional <vertical> is required\n");
      process.exit(2);
    }
    const client = makeClient();
    try {
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
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

export const connectorTemplatesCommand = defineCommand({
  meta: { name: "connector-templates", description: "Manage connector templates" },
  subCommands: {
    list: listCommand,
    create: createCommand,
    "set-oauth": setOauthCommand,
    delete: deleteCommand,
    recipes: recipesListCommand,
    recipe: recipeShowCommand,
    "recipe-pack": recipePackCommand,
  },
});
