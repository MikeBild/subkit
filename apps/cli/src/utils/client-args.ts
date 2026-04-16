// Shared citty arg definitions + resolver. Every command exposes
// `--engine-url`, `--api-key`, `--tenant`, `--profile`, and `--json`
// so scripts have consistent entry points.

import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

export const clientArgs = {
  "engine-url": { type: "string", description: "Engine base URL" },
  "api-key": { type: "string", description: "API key (Bearer)" },
  tenant: { type: "string", description: "Active tenant id" },
  profile: { type: "string", description: "Profile name (~/.subkit/config.json)" },
  json: { type: "boolean", description: "Emit machine-readable JSON" },
} as const;

export interface ResolvedClient {
  client: EngineClient;
  engine_url: string;
  asJson: boolean;
}

export function makeClient(args: Record<string, unknown>): ResolvedClient {
  const resolved = resolveProfile({
    engine_url: str(args["engine-url"]),
    api_key: str(args["api-key"]),
    tenant: str(args.tenant),
    profile: str(args.profile),
  });
  const client = new EngineClient({
    engine_url: resolved.engine_url,
    api_key: resolved.api_key,
    tenant: resolved.active_tenant_id,
  });
  return {
    client,
    engine_url: resolved.engine_url,
    asJson: Boolean(args.json),
  };
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
