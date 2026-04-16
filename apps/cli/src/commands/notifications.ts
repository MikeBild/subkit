// `subkit notifications rules|channels ...`
//
// Notifications do not yet have a dedicated HTTP surface on the engine.
// The commands are wired to print structured placeholders so scripts can
// invoke them without erroring.

import { defineCommand } from "citty";
import { clientArgs } from "../utils/client-args.ts";

function stub(kind: string, verb: string) {
  process.stdout.write(`notifications ${kind} ${verb}: not yet exposed on the engine\n`);
}

const rulesList = defineCommand({
  meta: { name: "list", description: "List notification rules" },
  args: clientArgs,
  async run() {
    stub("rules", "list");
  },
});
const rulesCreate = defineCommand({
  meta: { name: "create", description: "Create a notification rule" },
  args: { ...clientArgs, file: { type: "string", required: true } },
  async run() {
    stub("rules", "create");
  },
});
const rulesCmd = defineCommand({
  meta: { name: "rules", description: "Notification rules" },
  subCommands: { list: rulesList, create: rulesCreate },
});

const channelsList = defineCommand({
  meta: { name: "list", description: "List notification channels" },
  args: clientArgs,
  async run() {
    stub("channels", "list");
  },
});
const channelsCreate = defineCommand({
  meta: { name: "create", description: "Create a notification channel" },
  args: { ...clientArgs, file: { type: "string", required: true } },
  async run() {
    stub("channels", "create");
  },
});
const channelsCmd = defineCommand({
  meta: { name: "channels", description: "Notification channels" },
  subCommands: { list: channelsList, create: channelsCreate },
});

export const notificationsCommand = defineCommand({
  meta: { name: "notifications", description: "Notification rules + channels" },
  subCommands: { rules: rulesCmd, channels: channelsCmd },
});
