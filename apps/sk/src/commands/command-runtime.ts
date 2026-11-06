import { reportCommandError } from "@cli-core/errors";
import { type ResolveOptions, resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

export function makeClient(opts: ResolveOptions = {}): EngineClient {
  const { engine_url, api_key, active_tenant_id } = resolveProfile(opts);
  return new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
}

export async function withCommandErrors<T>(
  run: () => Promise<T>,
  opts?: { json?: boolean },
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    reportCommandError(err, opts);
  }
}

function profileOptionsFromArgs(args: Record<string, unknown>): ResolveOptions {
  return {
    engine_url: args["engine-url"] as string | undefined,
    api_key: args["api-key"] as string | undefined,
    profile: args.profile as string | undefined,
  };
}

export function makeClientFromArgs(args: Record<string, unknown>): EngineClient {
  return makeClient(profileOptionsFromArgs(args));
}
