import { getConfig, isConfigLoaded } from "./loader.ts";
import type { DeploymentMode } from "./schema.ts";

export type { DeploymentMode } from "./schema.ts";

export function currentDeploymentMode(): DeploymentMode {
  return isConfigLoaded() ? getConfig().deployment.mode : "server";
}
