import * as prompts from "@clack/prompts";
import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

const listCommand = defineCommand({
  meta: { name: "list", description: "List skills" },
  args: {
    limit: { type: "string", description: "Max rows", default: "20" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const { items } = await client.listSkills({ limit: Number(args.limit) });
      emitList(
        !!args.json,
        ["id", "title", "status", "connector_id"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get a skill by id" },
  args: {
    id: { type: "positional", required: true, description: "Skill id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const skill = await client.getSkill(args.id);
      printJson(skill);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const createCommand = defineCommand({
  meta: { name: "create", description: "Create a skill from a JSON file" },
  args: {
    file: { type: "string", required: true, description: "Path to SkillDef JSON" },
  },
  async run({ args }) {
    const { readFileSync } = await import("node:fs");
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const body = JSON.parse(readFileSync(String(args.file), "utf8")) as Record<string, unknown>;
      const skill = await client.createSkill(body);
      printJson(skill);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const patchCommand = defineCommand({
  meta: { name: "patch", description: "Update a skill" },
  args: {
    id: { type: "positional", required: true, description: "Skill id" },
    file: { type: "string", description: "Path to JSON patch file" },
    title: { type: "string", description: "New title" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      let body: Record<string, unknown> = {};
      if (args.file) {
        const { readFileSync } = await import("node:fs");
        body = JSON.parse(readFileSync(String(args.file), "utf8")) as Record<string, unknown>;
      }
      if (args.title) body.title = args.title;
      const skill = await client.patchSkill(args.id, body);
      printJson(skill);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const activateCommand = defineCommand({
  meta: { name: "activate", description: "Activate a skill" },
  args: {
    id: { type: "positional", required: true, description: "Skill id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      await client.activateSkill(args.id);
      process.stdout.write(`${pc.green("activated")}\n`);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const archiveCommand = defineCommand({
  meta: { name: "archive", description: "Archive a skill" },
  args: {
    id: { type: "positional", required: true, description: "Skill id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      await client.archiveSkill(args.id);
      process.stdout.write(`${pc.green("archived")}\n`);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a skill" },
  args: {
    id: { type: "positional", required: true, description: "Skill id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      if (process.stdin.isTTY) {
        const confirmed = await prompts.confirm({ message: `Delete skill "${args.id}"?` });
        if (!confirmed || prompts.isCancel(confirmed)) return;
      }
      await client.deleteSkill(args.id);
      process.stdout.write(`${pc.green("deleted")}\n`);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

export const skillsCommand = defineCommand({
  meta: { name: "skills", description: "Manage skills" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    create: createCommand,
    patch: patchCommand,
    edit: patchCommand,
    activate: activateCommand,
    archive: archiveCommand,
    delete: deleteCommand,
  },
});
