import { exitCodeFor, isEngineError, isTransportError } from "@cli-core/errors";
import { defineCommand } from "citty";
import {
  configPath,
  DEFAULT_ENGINE_URL,
  DEFAULT_PROFILE,
  loadConfig,
  saveProfile,
} from "../config.ts";
import { EngineClient, type FetchLike, type InviteRedeemedWire } from "../engine-client.ts";

const REDEEM_FRIENDLY: Record<string, string> = {
  invite_invalid:
    "that invite token is not valid — double-check you pasted it exactly as your admin sent it.",
  invite_expired: "that invite has expired — ask your admin to issue a new one.",
  invite_revoked: "that invite was revoked — ask your admin to issue a new one.",
  invite_already_redeemed:
    "that invite was already redeemed — each invite works only once. Ask your admin for a fresh one.",
  rate_limit_exceeded:
    "too many redeem attempts from your network — wait a few minutes and try again.",
};

interface RunJoinOptions {
  token: string;
  engine_url: string;
  profile: string;
  fetchImpl?: FetchLike;
  saveProfileImpl?: typeof saveProfile;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

interface RunJoinResult {
  status: "ok" | "failed";
  exitCode: number;
  redeemed?: InviteRedeemedWire;
  error?: { code: string; message: string };
}

export async function runJoin(opts: RunJoinOptions): Promise<RunJoinResult> {
  const save = opts.saveProfileImpl ?? saveProfile;
  const out = opts.out ?? ((line: string) => process.stdout.write(line));
  const err = opts.err ?? ((line: string) => process.stderr.write(line));

  const client = new EngineClient({
    engine_url: opts.engine_url,
    api_key: "",
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  let redeemed: InviteRedeemedWire;
  try {
    redeemed = await client.redeemInvite({ token: opts.token });
  } catch (e) {
    if (isTransportError(e)) {
      err(`subkit join: engine unreachable at ${opts.engine_url}: ${e.message}\n`);
      return {
        status: "failed",
        exitCode: 2,
        error: { code: "engine_unreachable", message: e.message },
      };
    }
    if (isEngineError(e)) {
      const friendly = REDEEM_FRIENDLY[e.code] ?? e.message;
      err(`subkit join: ${friendly} (code=${e.code})\n`);
      return {
        status: "failed",
        exitCode: exitCodeFor(e),
        error: { code: e.code, message: e.message },
      };
    }
    throw e;
  }

  save({
    name: opts.profile,
    engine_url: opts.engine_url,
    api_key: redeemed.api_key,
    active_tenant_id: redeemed.tenant_id,
  });
  out(
    `subkit join: joined — profile '${opts.profile}' saved to ${configPath()}\n` +
      `  personal api key prefix: ${redeemed.api_key_prefix}\n` +
      `  next: subkit status\n`,
  );
  return { status: "ok", exitCode: 0, redeemed };
}

export const joinCommand = defineCommand({
  meta: {
    name: "join",
    description: "Redeem an invite to provision your personal API key (no login required)",
  },
  args: {
    invite: {
      type: "string",
      required: true,
      description: "Single-use invite token from your admin",
    },
    "engine-url": {
      type: "string",
      description: "Engine base URL (defaults to http://localhost:3000)",
    },
    profile: {
      type: "string",
      description: `Profile to write the new key into (default: ${DEFAULT_PROFILE})`,
    },
  },
  async run({ args }) {
    const token = (args.invite as string | undefined)?.trim();
    if (!token) {
      process.stderr.write(
        "subkit join: --invite <token> is required.\n" +
          "  Ask your admin to issue one with `subkit users invite <user-id>`.\n",
      );
      process.exit(2);
    }
    const engineUrl =
      (args["engine-url"] as string | undefined) ??
      process.env.SUBKIT_ENGINE_URL ??
      DEFAULT_ENGINE_URL;
    const profileName =
      (args.profile as string | undefined) ?? loadConfig().active_profile ?? DEFAULT_PROFILE;

    const result = await runJoin({ token, engine_url: engineUrl, profile: profileName });
    process.exit(result.exitCode);
  },
});
