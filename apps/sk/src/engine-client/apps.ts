import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";

export type AppSummary = components["schemas"]["AppSummary"];
export type AppView = components["schemas"]["AppView"];
export type AppListResponse = components["schemas"]["AppListResponse"];
export type AppCheck = components["schemas"]["AppCheck"];
export type ErasedAppUser = components["schemas"]["ErasedAppUser"];

export const appsMethods = {
  async listApps(this: EngineClient): Promise<AppListResponse> {
    const { data } = await this.api.GET("/v1/apps");
    return data as AppListResponse;
  },
  async getApp(this: EngineClient, id: string): Promise<AppView> {
    const { data } = await this.api.GET("/v1/apps/{id}", { params: { path: { id } } });
    return data as AppView;
  },
  async eraseAppUser(this: EngineClient, appId: string, userId: string): Promise<ErasedAppUser> {
    const { data } = await this.api.DELETE("/v1/apps/{id}/users/{user_id}", {
      params: { path: { id: appId, user_id: userId } },
    });
    return data as ErasedAppUser;
  },
};
