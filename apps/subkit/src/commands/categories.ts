import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

const listCommand = defineCommand({
  meta: {
    name: "list",
    description:
      "List the catalog categories with how many workflows, connectors, knowledge sources, skills, files and tasks use each",
  },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    return withCommandErrors(
      async () => {
        const { categories } = await makeClient().listCategories();
        emitList(
          Boolean(args.json),
          [
            "category",
            "total",
            "workflow",
            "connector",
            "knowledge_source",
            "skill",
            "file",
            "task",
          ],
          categories.map((c) => ({ category: c.category, total: c.total, ...c.counts })),
        );
      },
      { json: Boolean(args.json) },
    );
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
    return withCommandErrors(
      async () => {
        const result = await makeClient().renameCategory(String(args.from), String(args.to));
        if (args.json) return printJson(result);
        process.stdout.write(
          `${pc.green("✓")} ${result.from} → ${result.to}: ${result.total} object${result.total === 1 ? "" : "s"} moved\n`,
        );
      },
      { json: Boolean(args.json) },
    );
  },
});

export const categoriesCommand = defineCommand({
  meta: {
    name: "categories",
    description: "Show and rename the catalog categories shared by every kind",
  },
  subCommands: { list: listCommand, rename: renameCommand },
});
