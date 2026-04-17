// `subkit skills ...`

import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne } from "../utils/format.ts";

const listCmd = defineCommand({
  meta: { name: "list", description: "List skills" },
  args: {
    ...clientArgs,
    "show-source": {
      type: "boolean",
      description: "Include the provenance column (manual/candidate/template/memory)",
      default: false,
    },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.listSkills();
    const columns = args["show-source"]
      ? ["id", "title", "scope", "source", "status"]
      : ["id", "title", "scope", "status"];
    emitList(asJson, columns, body.items as unknown as Record<string, unknown>[]);
  },
});

const getCmd = defineCommand({
  meta: { name: "get", description: "Fetch a skill" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Skill id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const s = await client.getSkill(args.id as string);
    emitOne(asJson, s as unknown as Record<string, unknown>);
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Create a skill from a JSON file" },
  args: {
    ...clientArgs,
    file: { type: "string", description: "Path to skill JSON", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = JSON.parse(readFileSync(args.file as string, "utf8")) as Record<string, unknown>;
    const created = await client.createSkill(body);
    emitOne(asJson, created as unknown as Record<string, unknown>);
  },
});

const editCmd = defineCommand({
  meta: { name: "edit", description: "Update a skill from a JSON file" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Skill id", required: true },
    file: { type: "string", description: "Path to skill patch JSON", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = JSON.parse(readFileSync(args.file as string, "utf8")) as Record<string, unknown>;
    const updated = await client.patchSkill(args.id as string, body);
    emitOne(asJson, updated as unknown as Record<string, unknown>);
  },
});

const activateCmd = defineCommand({
  meta: { name: "activate", description: "Activate a skill" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Skill id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const s = await client.activateSkill(args.id as string);
    emitOne(asJson, s as unknown as Record<string, unknown>);
  },
});

const archiveCmd = defineCommand({
  meta: { name: "archive", description: "Archive a skill" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Skill id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const s = await client.archiveSkill(args.id as string);
    emitOne(asJson, s as unknown as Record<string, unknown>);
  },
});

const deleteCmd = defineCommand({
  meta: {
    name: "delete",
    description: "Hard-delete a skill (prefer `archive` for operator-visible flows)",
  },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Skill id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    await client.deleteSkill(args.id as string);
    emitOne(asJson, { deleted: true, id: args.id as string });
  },
});

export const skillsCommand = defineCommand({
  meta: { name: "skills", description: "Skill management" },
  subCommands: {
    list: listCmd,
    get: getCmd,
    create: createCmd,
    edit: editCmd,
    activate: activateCmd,
    archive: archiveCmd,
    delete: deleteCmd,
  },
});
