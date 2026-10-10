import { reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { EngineClient, type IntakeItem } from "../engine-client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REVIEW_ITEMS = 100;
const ESCAPE = String.fromCharCode(27);
const OSC_ESCAPE = new RegExp(`${ESCAPE}\\][\\s\\S]*?(?:\\x07|${ESCAPE}\\\\)`, "g");
const CSI_ESCAPE = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, "g");
const CONTROL_CHARACTER = new RegExp(`[${String.raw`\u0000-\u001F\u007F`}]`, "g");

function makeClient(): EngineClient {
  const { engine_url, api_key, active_tenant_id } = resolveProfile();
  return new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
}

function terminalText(value: string): string {
  return value.replace(OSC_ESCAPE, "").replace(CSI_ESCAPE, "").replace(CONTROL_CHARACTER, " ");
}

export function intakeCategory(value: string): string {
  const category = value.trim();
  if (!category) throw new Error("--category needs a category name");
  return category;
}

export function intakeItemId(value: string): string {
  if (!UUID.test(value)) throw new Error("--item needs a UUID");
  return value;
}

export function intakeItemIds(value: string): string[] {
  const parts = value.split(",");
  if (parts.length === 0 || parts.some((part) => !UUID.test(part)))
    throw new Error("--items must be a comma-separated list of UUIDs");
  if (new Set(parts).size !== parts.length)
    throw new Error("--items must not contain the same item twice");
  if (parts.length > MAX_REVIEW_ITEMS)
    throw new Error(`--items accepts at most ${MAX_REVIEW_ITEMS} items`);
  return parts;
}

function reviewPrompt(category: string): string {
  return `Review my new items in “${terminalText(category)}”. Which ones help us? For each suggestion, show the exact text, sources and knowledge destination for my confirmation.`;
}

function cockpitConversationUrl(client: EngineClient, conversationId: string): string {
  const url = new URL(client.base);
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}/cockpit/chat/${encodeURIComponent(conversationId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function clipMetadata(item: IntakeItem): Record<string, unknown> {
  return {
    id: item.id,
    category: item.category,
    title: item.title,
    source_url: item.original_snapshot.source_url,
    captured_at: item.original_snapshot.captured_at,
    state: item.state,
  };
}

async function collectedItems(client: EngineClient, category: string): Promise<IntakeItem[]> {
  return (await client.listIntakeItems({ category, state: "collected" })).items;
}

async function selectedCategory(
  client: EngineClient,
  supplied: string | undefined,
): Promise<string> {
  return supplied === undefined
    ? (await client.getDefaultIntakeCategory()).category
    : intakeCategory(supplied);
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List collected intake items in one shared category" },
  args: {
    category: { type: "string", description: "Shared category name" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const jsonMode = Boolean(args.json);
    try {
      const client = makeClient();
      const category = await selectedCategory(client, args.category);
      const items = await collectedItems(client, category);
      if (jsonMode) {
        printJson({ category, items: items.map(clipMetadata) });
        return;
      }
      emitList(
        false,
        ["title", "source_url", "captured_at"],
        items.map((item) => ({
          title: terminalText(item.title),
          source_url: terminalText(item.original_snapshot.source_url),
          captured_at: item.original_snapshot.captured_at,
        })),
      );
    } catch (error) {
      reportCommandError(error, { json: jsonMode });
    }
  },
});

const reviewCommand = defineCommand({
  meta: {
    name: "review",
    description: "Start a selected intake review in authenticated Cockpit chat",
  },
  args: {
    category: { type: "string", description: "Shared category name" },
    items: { type: "string", description: "Comma-separated item UUIDs" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const jsonMode = Boolean(args.json);
    try {
      if (args.category !== undefined && args.items !== undefined)
        throw new Error("use either --category or --items, not both");
      const client = makeClient();
      if (args.items !== undefined) {
        const selectedIds = intakeItemIds(args.items);
        const outcome = await client.createConversation({
          initial_message: reviewPrompt("these selected items"),
          intake_item_ids: selectedIds,
        });
        const url = cockpitConversationUrl(client, outcome.conversation.id);
        if (jsonMode) {
          printJson({
            conversation_url: url,
            category: null,
            items: selectedIds.map((id) => ({ id })),
          });
          return;
        }
        process.stdout.write(
          `Review started for ${selectedIds.length} collected item${selectedIds.length === 1 ? "" : "s"}.\n`,
        );
        process.stdout.write(`Continue in authenticated Cockpit: ${url}\n`);
        return;
      }
      const category = await selectedCategory(client, args.category);
      const items = await collectedItems(client, category);
      if (items.length > MAX_REVIEW_ITEMS)
        throw new Error(
          `category “${terminalText(category)}” has more than ${MAX_REVIEW_ITEMS} collected items; choose --items`,
        );
      const selectedIds = items.map((item) => item.id);
      if (selectedIds.length === 0)
        throw new Error(`category “${terminalText(category)}” has no collected items to review`);
      const outcome = await client.createConversation({
        initial_message: reviewPrompt(category),
        intake_item_ids: selectedIds,
      });
      const url = cockpitConversationUrl(client, outcome.conversation.id);
      if (jsonMode) {
        printJson({ conversation_url: url, category, items: items.map(clipMetadata) });
        return;
      }
      process.stdout.write(
        `Review started for ${selectedIds.length} collected item${selectedIds.length === 1 ? "" : "s"}.\n`,
      );
      process.stdout.write(`Continue in authenticated Cockpit: ${url}\n`);
    } catch (error) {
      reportCommandError(error, { json: jsonMode });
    }
  },
});

async function mutateItem(
  client: EngineClient,
  itemId: string,
  input: { category?: string; state?: "collected" | "discarded" },
): Promise<IntakeItem> {
  const current = await client.getIntakeItem(itemId);
  return client.patchIntakeItem(current.id, { ...input, expected_version: current.version });
}

function mutationResult(item: IntakeItem): Record<string, unknown> {
  return { id: item.id, category: item.category, state: item.state, version: item.version };
}

const defaultCommand = defineCommand({
  meta: { name: "default", description: "Set your personal default intake category" },
  args: {
    category: { type: "string", required: true, description: "Shared category name" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const jsonMode = Boolean(args.json);
    try {
      const category = intakeCategory(args.category);
      const result = await makeClient().setDefaultIntakeCategory(category);
      if (jsonMode) printJson(result);
      else process.stdout.write(`Default intake category: ${terminalText(result.category)}\n`);
    } catch (error) {
      reportCommandError(error, { json: jsonMode });
    }
  },
});

function itemMutationCommand(
  name: "move" | "discard" | "restore",
  description: string,
  input: (args: { category?: string | undefined }) => {
    category?: string;
    state?: "collected" | "discarded";
  },
) {
  return defineCommand({
    meta: { name, description },
    args: {
      item: { type: "string", required: true, description: "Intake item UUID" },
      category: { type: "string", description: "Shared category name" },
      json: { type: "boolean", description: "JSON output" },
    },
    async run({ args }) {
      const jsonMode = Boolean(args.json);
      try {
        const itemId = intakeItemId(args.item);
        const result = await mutateItem(makeClient(), itemId, input(args));
        const output = mutationResult(result);
        if (jsonMode) printJson(output);
        else process.stdout.write(`${name}: ${terminalText(result.title)}\n`);
      } catch (error) {
        reportCommandError(error, { json: jsonMode });
      }
    },
  });
}

const moveCommand = itemMutationCommand(
  "move",
  "Move an intake item to a shared category",
  (args) => ({
    category: intakeCategory(args.category ?? ""),
  }),
);
const discardCommand = itemMutationCommand("discard", "Discard an intake item", () => ({
  state: "discarded",
}));
const restoreCommand = itemMutationCommand("restore", "Restore a discarded intake item", () => ({
  state: "collected",
}));

export const intakeCommand = defineCommand({
  meta: { name: "intake", description: "List collected items and start a selected Chat review" },
  subCommands: {
    list: listCommand,
    review: reviewCommand,
    default: defaultCommand,
    move: moveCommand,
    discard: discardCommand,
    restore: restoreCommand,
  },
});
