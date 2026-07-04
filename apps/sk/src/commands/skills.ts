import * as prompts from "@clack/prompts";
import { reportCommandError } from "@cli-core/errors";
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
      reportCommandError(err, { json: Boolean(args.json) });
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
      reportCommandError(err);
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
      reportCommandError(err);
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
      reportCommandError(err);
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
      reportCommandError(err);
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
      reportCommandError(err);
    }
  },
});

const historyCommand = defineCommand({
  meta: { name: "history", description: "Show a skill's version history (newest first)" },
  args: {
    id: { type: "positional", required: true, description: "Skill id" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const { items } = await client.skillHistory(args.id);
      emitList(
        !!args.json,
        ["audit_entry_id", "version", "title", "lifecycle", "updated_at", "has_snapshot"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const restoreCommand = defineCommand({
  meta: { name: "restore", description: "Restore a skill to a prior audited snapshot" },
  args: {
    id: { type: "positional", required: true, description: "Skill id" },
    to: {
      type: "string",
      required: true,
      description: "audit_entry_id from `sk skills history`",
    },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const skill = await client.restoreSkill(args.id, String(args.to));
      printJson(skill);
    } catch (err) {
      reportCommandError(err);
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
      reportCommandError(err);
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
    history: historyCommand,
    restore: restoreCommand,
    delete: deleteCommand,
  },
});
