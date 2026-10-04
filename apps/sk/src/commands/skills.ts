import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as prompts from "@clack/prompts";
import { reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";
import { planSync, SKILL_TARGET_DIRS, type SyncSkill } from "../lib/skill-sync.ts";
import { AGENT_FILE_RELPATH, findAgentFile } from "./agent.ts";

const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "Materialize domain skills as SKILL.md for Claude Code and Codex",
  },
  args: {
    domains: {
      type: "string",
      description: "Comma-separated domain slugs (default: .sk/agent.json of the repo)",
    },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    try {
      const fromFile = args.domains ? null : findAgentFile(process.cwd());
      const domains = args.domains
        ? args.domains
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean)
        : (fromFile?.config.domains ?? []);
      if (domains.length === 0) {
        process.stdout.write(
          `sk skills sync: no domains — pass --domains or declare ${AGENT_FILE_RELPATH} (sk agent init)\n`,
        );
        process.exitCode = 2;
        return;
      }
      const root = fromFile ? dirname(dirname(fromFile.path)) : process.cwd();
      const wantedTags = new Set(domains.map((d) => `domain:${d}`));

      const { engine_url, api_key, active_tenant_id } = resolveProfile();
      const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
      const { items } = await client.listSkills({ status: "active", limit: 500 });
      const skills = (items as unknown as SyncSkill[]).filter((s) =>
        (s.tags ?? []).some((t) => wantedTags.has(t)),
      );

      const summary: Record<string, { written: string[]; pruned: string[]; unchanged: number }> =
        {};
      for (const target of SKILL_TARGET_DIRS) {
        const base = join(root, target);
        const existing = new Map<string, string>();
        if (existsSync(base)) {
          for (const entry of readdirSync(base, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const mdPath = join(base, entry.name, "SKILL.md");
            if (existsSync(mdPath)) existing.set(entry.name, readFileSync(mdPath, "utf8"));
          }
        }
        const plan = planSync(skills, existing);
        for (const [dir, content] of plan.writes) {
          mkdirSync(join(base, dir), { recursive: true });
          writeFileSync(join(base, dir, "SKILL.md"), content);
        }
        for (const dir of plan.prunes) {
          rmSync(join(base, dir), { recursive: true, force: true });
        }
        summary[target] = {
          written: [...plan.writes.keys()].sort(),
          pruned: plan.prunes,
          unchanged: plan.unchanged.length,
        };
      }

      if (args.json) {
        printJson({ root, domains, skills: skills.length, targets: summary });
        return;
      }
      process.stdout.write(
        `${pc.green("✓")} ${skills.length} skill(s) for ${domains.join(", ")} → ${root}\n`,
      );
      for (const [target, s] of Object.entries(summary)) {
        process.stdout.write(
          `  ${target}: ${s.written.length} written, ${s.unchanged} unchanged, ${s.pruned.length} pruned` +
            `${s.written.length > 0 ? ` (${s.written.join(", ")})` : ""}\n`,
        );
      }
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

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
    sync: syncCommand,
  },
});
