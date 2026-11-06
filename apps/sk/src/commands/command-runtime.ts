import { reportCommandError } from "@cli-core/errors";
import { type ResolveOptions, resolveProfile } from "../config.ts";
import { type ClientOptions, EngineClient } from "../engine-client.ts";

export function makeClient(
  opts: ResolveOptions & Pick<ClientOptions, "language"> = {},
): EngineClient {
  const { language, ...profile } = opts;
  const { engine_url, api_key, active_tenant_id } = resolveProfile(profile);
  return new EngineClient({
    engine_url,
    api_key,
    tenant: active_tenant_id,
    ...(language ? { language } : {}),
  });
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
