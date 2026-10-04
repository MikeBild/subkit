import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../openapi.ts";
import { registerOAuthConsentRoutes } from "./oauth/consent.ts";
import { registerOAuthDcrRoutes } from "./oauth/dcr.ts";
import { registerOAuthDiscoveryRoutes } from "./oauth/discovery.ts";
import { registerRawMcpAuthOpenApi } from "./oauth/openapi.ts";
import { registerOAuthTokenRoutes } from "./oauth/token.ts";

export function registerMcpOAuthRoutes(app: OpenAPIHono<AppEnv>): void {
  registerRawMcpAuthOpenApi(app);
  registerOAuthDiscoveryRoutes(app);
  registerOAuthDcrRoutes(app);
  registerOAuthConsentRoutes(app);
  registerOAuthTokenRoutes(app);
}
