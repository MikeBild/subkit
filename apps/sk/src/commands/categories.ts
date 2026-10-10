import { reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

function makeClient(): EngineClient {
  const { engine_url, api_key, active_tenant_id } = resolveProfile();
  return new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
}

const listCommand = defineCommand({
  meta: {
    name: "list",
    description:
      "List the catalog categories with how many workflows, connectors, knowledge sources, skills and files use each",
  },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    try {
      const { categories } = await makeClient().listCategories();
      emitList(
        Boolean(args.json),
        ["category", "total", "workflow", "connector", "knowledge_source", "skill", "file"],
        categories.map((c) => ({ category: c.category, total: c.total, ...c.counts })),
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const renameCommand = defineCommand({
  meta: {
    name: "rename",
    description:
      "Rename across all kinds with revision checks; preserve purpose ownership and merge into an existing target",
  },
  args: {
    from: { type: "positional", required: true, description: "Current category" },
    to: { type: "positional", required: true, description: "New category" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    try {
      const result = await makeClient().renameCategory(String(args.from), String(args.to));
      if (args.json) return printJson(result);
      process.stdout.write(
        `${pc.green("✓")} ${result.from} → ${result.to}: ${result.total} object${result.total === 1 ? "" : "s"} moved\n`,
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

export const categoriesCommand = defineCommand({
  meta: {
    name: "categories",
    description: "Show and rename the catalog categories shared by every kind",
  },
  subCommands: { list: listCommand, rename: renameCommand },
});
