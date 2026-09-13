// `sk chat` — register external chat spaces (Google Chat / Slack) with
// the engine, replacing raw curl to POST /v1/chat/workspaces.
//
// The star verb is `install-space`: in a TTY with no args it lists the
// spaces you just added the app to (GET /v1/chat/spaces/pending) and
// installs the picked one with your verified platform id auto-filled —
// zero typed ids. Google Chat is live; Slack degrades to a manual
// `<platform> <workspace_id> --bot-token …` path (its per-workspace
// token model carries no pre-install discovery signal). This surface is
// distinct from `sk install slack|teams`, which wires OUTBOUND
// notification webhooks — a different resource.

import * as prompts from "@clack/prompts";
import { reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";

import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";
import type {
  ChatPlatform,
  InstallChatWorkspaceBody,
  PendingChatSpaceWire,
} from "../engine-client/chat.ts";
import { pickId } from "../lib/pick.ts";

function makeClient() {
  const profile = resolveProfile();
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

const spacesCommand = defineCommand({
  meta: { name: "spaces", description: "List chat spaces installed in this tenant" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listChatWorkspaces();
      if (args.json) {
        printJson(items);
        return;
      }
      emitList(
        false,
        ["id", "platform", "workspace_id", "default_channel", "created_at"],
        items as unknown as Record<string, unknown>[],
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const installSpaceCommand = defineCommand({
  meta: {
    name: "install-space",
    description: "Register a chat space with the engine (Google Chat / Slack)",
  },
  args: {
    platform: { type: "positional", required: false, description: "google_chat | slack" },
    workspace_id: {
      type: "positional",
      required: false,
      description: "Native space id, e.g. spaces/<id> (Slack: team id T…)",
    },
    "bot-token": { type: "string", description: "Slack bot token (xoxb-…) — required for slack" },
    "default-channel": { type: "string", description: "Optional default channel" },
    as: {
      type: "string",
      description: "Installer platform user id (auto-filled from a pending space when omitted)",
    },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      // Pending candidates key the friendly path: they carry the space
      // AND the caller's verified installer id. Fetched once; used both
      // to power the no-args picker and to auto-fill `--as`.
      let pending: PendingChatSpaceWire[] = [];
      try {
        pending = (await client.listPendingChatSpaces()).items;
      } catch {
        // Discovery is best-effort (e.g. caller lacks chat_workspace:read
        // or nothing pending) — fall through to the manual path.
        pending = [];
      }
      const byWorkspace = new Map(pending.map((c) => [c.workspace_id, c]));

      // Resolve the target space id: explicit arg, else pick a pending one.
      let workspaceId = args.workspace_id;
      if (!workspaceId) {
        if (pending.length === 0) {
          throw new Error(
            "no pending spaces to pick — add the app to a space and message it once, " +
              "or install explicitly: sk chat install-space <platform> <workspace_id> --as <your-id>",
          );
        }
        workspaceId = await pickId({
          label: "chat space",
          fetch: async () =>
            pending.map((c) => ({
              id: c.workspace_id,
              name: c.display_name ?? c.workspace_id,
              detail: c.platform,
            })),
        });
      }

      const candidate = byWorkspace.get(workspaceId);

      // Platform: candidate wins; else the arg; else prompt.
      let platform = candidate?.platform ?? (args.platform as ChatPlatform | undefined);
      if (!platform) {
        const picked = await prompts.select({
          message: "Which platform?",
          options: [
            { value: "google_chat", label: "Google Chat" },
            { value: "slack", label: "Slack" },
          ],
        });
        if (prompts.isCancel(picked)) throw new Error("platform is required");
        platform = picked as ChatPlatform;
      }

      // Installer id: candidate (verified) or the --as override.
      const installer = args.as ?? candidate?.installer_platform_user_id;
      if (!installer) {
        throw new Error(
          "installer id required — pass --as <your platform user id>, " +
            "or message the space first so it appears in the picker (auto-fills it)",
        );
      }

      // Slack needs a per-workspace bot token; Google omits it.
      let botToken = args["bot-token"];
      if (platform === "slack" && !botToken) {
        const entered = await prompts.text({
          message: "Slack bot token (xoxb-…)",
          validate: (v) => (v?.startsWith("xoxb-") ? undefined : "expected an xoxb- token"),
        });
        if (typeof entered !== "string") throw new Error("bot_token is required for slack");
        botToken = entered;
      }

      const body: InstallChatWorkspaceBody = {
        platform,
        workspace_id: workspaceId,
        installer_platform_user_id: installer,
        ...(botToken ? { bot_token: botToken } : {}),
        ...(args["default-channel"] ? { default_channel: args["default-channel"] } : {}),
      };
      const result = await client.installChatWorkspace(body);
      if (args.json) {
        printJson(result);
        return;
      }
      const label = candidate?.display_name ?? result.workspace_id;
      process.stdout.write(
        `installed ${result.platform} space ${label} — chat there now; /new resets it\n`,
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const removeSpaceCommand = defineCommand({
  meta: { name: "remove-space", description: "Remove a chat-space install" },
  args: {
    id: { type: "positional", required: false, description: "Chat workspace row id" },
    yes: { type: "boolean", description: "Skip confirmation" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const id = await pickId({
        label: "chat workspace id",
        argValue: args.id,
        fetch: async () => {
          const { items } = await client.listChatWorkspaces();
          return items.map((w) => ({ id: w.id, name: w.workspace_id, detail: w.platform }));
        },
      });
      if (!args.yes) {
        const confirmed = await prompts.confirm({ message: `Remove chat space "${id}"?` });
        if (!confirmed || prompts.isCancel(confirmed)) return;
      }
      const result = await client.removeChatWorkspace(id);
      if (args.json) {
        printJson(result);
        return;
      }
      process.stdout.write("removed\n");
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

export const chatCommand = defineCommand({
  meta: { name: "chat", description: "Manage external chat spaces (Google Chat / Slack)" },
  subCommands: {
    spaces: spacesCommand,
    "install-space": installSpaceCommand,
    "remove-space": removeSpaceCommand,
  },
});
