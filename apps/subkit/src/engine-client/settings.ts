import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { AUDIT_SOURCE_HEADER, type AuditSource } from "@shared/audit-source.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody } from "./http.ts";

type Schemas = components["schemas"];

const SUBKIT_CLI_AUDIT_SOURCE = "sk_cli" satisfies AuditSource;

export type SettingLeafMeta = Schemas["SettingLeafMeta"];

export type SettingSource = SettingLeafMeta["source"];

export type SettingLeafEntry = Schemas["SettingLeafEntry"];

export type SettingsListResponse = Pick<Schemas["SettingsListResponse"], "items" | "diagnostics">;

export type SettingPutResult = Schemas["SettingPutResult"];

export type EngineRestartStatus = Schemas["EngineRestartStatus"];

export type EngineRestartAccepted = Schemas["EngineRestartAccepted"];

export const settingsMethods = {
  async requestEngineRestart(this: EngineClient): Promise<EngineRestartAccepted> {
    const { data } = await this.api.POST("/v1/system/restart");
    return data as EngineRestartAccepted;
  },

  async getEngineRestartStatus(this: EngineClient): Promise<EngineRestartStatus> {
    const { data } = await this.api.GET("/v1/system/restart-status");
    return data as EngineRestartStatus;
  },

  async listSettings(
    this: EngineClient,
    opts: { tenant?: string } = {},
  ): Promise<Schemas["SettingsListResponse"]> {
    const { data } = await this.api.GET("/v1/settings", {
      params: { query: opts.tenant ? { tenant: opts.tenant } : {} },
    });
    return data as Schemas["SettingsListResponse"];
  },

  async getSetting(
    this: EngineClient,
    path: string,
    opts: { tenant?: string } = {},
  ): Promise<SettingLeafEntry> {
    const { data } = await this.api.GET("/v1/settings/{path}", {
      params: { path: { path }, query: opts.tenant ? { tenant: opts.tenant } : {} },
    });
    return data as SettingLeafEntry;
  },

  async setSetting(
    this: EngineClient,
    path: string,
    value: unknown,
    opts: { tenant?: string; force?: boolean } = {},
  ): Promise<SettingPutResult> {
    const body: ApiBody<"/v1/settings/{path}", "put"> = opts.force
      ? { value, force: true }
      : { value };
    const { data } = await this.api.PUT("/v1/settings/{path}", {
      params: {
        path: { path },
        query: opts.tenant ? { tenant: opts.tenant } : {},
        header: { [AUDIT_SOURCE_HEADER]: SUBKIT_CLI_AUDIT_SOURCE },
      },
      body,
    });
    return data as SettingPutResult;
  },
};
