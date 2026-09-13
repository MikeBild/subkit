// `sk invites` — admin view over the user-provisioning invites issued
// by `sk users invite`. The plaintext token is shown only at issue
// time (see `sk users invite`); this surface lists the live invites and
// revokes un-redeemed ones. The invited user redeems via `sk join`.

import { reportCommandError } from "@cli-core/errors";
import { emitList } from "@cli-core/format";
import { defineCommand } from "citty";

import { resolveProfile } from "../config.ts";
import { EngineClient, type UserInviteWire } from "../engine-client.ts";

function makeClient() {
  const profile = resolveProfile();
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

/**
 * Derive a display status from the invite's timestamps. The list route
 * serializes the raw `redeemed_at` / `revoked_at` / `expires_at`
 * columns (no precomputed `status` field), so the CLI derives the same
 * four-state label the route's `?status=` filter accepts.
 */
export function inviteStatus(invite: UserInviteWire, nowMs: number = Date.now()): string {
  if (invite.revoked_at) return "revoked";
  if (invite.redeemed_at) return "redeemed";
  if (Date.parse(invite.expires_at) <= nowMs) return "expired";
  return "pending";
}

const listCmd = defineCommand({
  meta: { name: "list", description: "List provisioning invites" },
  args: {
    status: {
      type: "string",
      description: "Filter by status: pending|redeemed|revoked|expired",
    },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const query: { status?: "pending" | "redeemed" | "revoked" | "expired" } = {};
      if (args.status) {
        const s = String(args.status);
        if (s !== "pending" && s !== "redeemed" && s !== "revoked" && s !== "expired") {
          process.stderr.write(
            "sk invites list: --status must be one of pending|redeemed|revoked|expired\n",
          );
          process.exit(2);
        }
        query.status = s;
      }
      const { items } = await client.listInvites(query);
      const rows = items.map((v) => ({
        id: v.id,
        user: v.user_id,
        status: inviteStatus(v),
        expires: v.expires_at,
      }));
      emitList(!!args.json, ["id", "user", "status", "expires"], rows);
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const revokeCmd = defineCommand({
  meta: { name: "revoke", description: "Revoke an un-redeemed invite" },
  args: { id: { type: "positional", required: true, description: "Invite id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.revokeInvite(String(args.id));
      process.stdout.write("revoked\n");
    } catch (err) {
      reportCommandError(err);
    }
  },
});

export const invitesCommand = defineCommand({
  meta: { name: "invites", description: "Manage user-provisioning invites" },
  subCommands: { list: listCmd, revoke: revokeCmd },
});
