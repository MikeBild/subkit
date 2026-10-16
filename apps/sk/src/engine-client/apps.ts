import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";

export type AppSummary = components["schemas"]["AppSummary"];
export type AppView = components["schemas"]["AppView"];
export type AppListResponse = components["schemas"]["AppListResponse"];
export type AppCheck = components["schemas"]["AppCheck"];

export const appsMethods = {
  listApps(this: EngineClient): Promise<AppListResponse> {
    return this.request("GET", "/v1/apps");
  },
  getApp(this: EngineClient, id: string): Promise<AppView> {
    return this.request("GET", `/v1/apps/${encodeURIComponent(id)}`);
  },
};
