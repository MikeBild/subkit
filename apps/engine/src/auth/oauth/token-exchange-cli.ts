import { readFileSync } from "node:fs";
import { SYSTEM_TENANT_ID } from "../../audit/index.ts";
import { closeDb, getDb } from "../../db/client.ts";
import { newTraceId, withContext } from "../../logging/context.ts";
import { logger, routeLogsToStderr } from "../../logging/logger.ts";
import {
  API_KEY_TOKEN_TYPE,
  exchangeApiKeyForToken,
  TOKEN_EXCHANGE_MAX_TTL_SECONDS,
  TokenExchangeError,
} from "./token-exchange.ts";

export interface TokenExchangeCliArgs {
  keyFile: string;
  scope?: string;
  ttl?: number;
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return next;
}

export function parseTokenExchangeArgs(argv: string[]): TokenExchangeCliArgs {
  const keyFile = valueAfter(argv, "--key-file");
  if (!keyFile) {
    throw new Error("--key-file <path> is required (the key is read from a file, never argv)");
  }
  const scopeValues: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scope") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error("--scope needs a value");
      scopeValues.push(next);
      i += 1;
    } else if (arg?.startsWith("--scope=")) {
      scopeValues.push(arg.slice("--scope=".length));
    }
  }
  const ttlRaw = valueAfter(argv, "--ttl");
  let ttl: number | undefined;
  if (ttlRaw !== undefined) {
    ttl = Number(ttlRaw);
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > TOKEN_EXCHANGE_MAX_TTL_SECONDS) {
      throw new Error(`--ttl must be an integer between 1 and ${TOKEN_EXCHANGE_MAX_TTL_SECONDS}`);
    }
  }
  return {
    keyFile,
    ...(scopeValues.length > 0 ? { scope: scopeValues.join(" ") } : {}),
    ...(ttl !== undefined ? { ttl } : {}),
  };
}

export function readKeyFile(path: string): string {
  const raw = readFileSync(path, "utf8");
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) throw new Error(`${path} holds no key`);
  return line;
}

export async function runTokenExchangeCli(
  argv: string[],
  loadConfig: () => Promise<unknown>,
): Promise<void> {
  routeLogsToStderr();
  await withContext(
    {
      trace_id: newTraceId(),
      tenant_id: SYSTEM_TENANT_ID,
      request_source: "cli",
      actor_id: "token-exchange",
    },
    async () => {
      try {
        const args = parseTokenExchangeArgs(argv);
        const subjectToken = readKeyFile(args.keyFile);
        await loadConfig();
        const result = await exchangeApiKeyForToken({
          db: getDb(),
          subjectToken,
          subjectTokenType: API_KEY_TOKEN_TYPE,
          ...(args.scope !== undefined ? { scope: args.scope } : {}),
          ...(args.ttl !== undefined ? { ttl: args.ttl } : {}),
          requestSource: "cli",
        });
        process.stdout.write(`${result.access_token}\n`);
        await closeDb();
        process.exit(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const oauthError = err instanceof TokenExchangeError ? err.oauth_error : undefined;
        logger.fatal({
          module: "engine",
          action: "token_exchange.cli_failed",
          msg: "engine --token-exchange failed",
          ...(oauthError ? { oauth_error: oauthError } : {}),
          error: message,
        });
        process.stderr.write(`engine --token-exchange: ${oauthError ?? "error"}: ${message}\n`);
        process.exit(1);
      }
    },
  );
}
