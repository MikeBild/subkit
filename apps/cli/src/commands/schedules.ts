// `subkit schedules ...`
//
// Scheduling is wired through the engine's scheduler/reconciler; a
// dedicated HTTP surface is not yet part of the engine (P15). Until it
// ships these commands print a structured placeholder so tooling can
// still invoke them.

import { defineCommand } from "citty";
import { clientArgs } from "../utils/client-args.ts";

function notImplemented(verb: string) {
  process.stdout.write(`schedules ${verb}: endpoint not yet exposed on the engine\n`);
}

const listCmd = defineCommand({
  meta: { name: "list", description: "List schedules" },
  args: clientArgs,
  async run() {
    notImplemented("list");
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Create a schedule" },
  args: {
    ...clientArgs,
    workflow: { type: "string", description: "Workflow id", required: true },
    cron: { type: "string", description: "Cron expression", required: true },
  },
  async run() {
    notImplemented("create");
  },
});

const pauseCmd = defineCommand({
  meta: { name: "pause", description: "Pause a schedule" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Schedule id", required: true },
  },
  async run() {
    notImplemented("pause");
  },
});

const resumeCmd = defineCommand({
  meta: { name: "resume", description: "Resume a schedule" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Schedule id", required: true },
  },
  async run() {
    notImplemented("resume");
  },
});

export const schedulesCommand = defineCommand({
  meta: { name: "schedules", description: "Workflow schedules (cron)" },
  subCommands: { list: listCmd, create: createCmd, pause: pauseCmd, resume: resumeCmd },
});
