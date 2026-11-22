import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../openapi.ts";

export const ENGINE_VERSION_HEADER = "x-subkit-version";

export function versionHeaderMiddleware(version: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.header(ENGINE_VERSION_HEADER, version);
    await next();
  };
}
