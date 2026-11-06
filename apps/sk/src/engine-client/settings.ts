import { AUDIT_SOURCE_HEADER, type AuditSource } from "@shared/audit-source.ts";
import type { EngineClient } from "../engine-client.ts";

const SK_CLI_AUDIT_SOURCE = "sk_cli" satisfies AuditSource;

export type SettingSource = "override" | "tenant" | "global" | "default";

export interface SettingLeafMeta {
  source: SettingSource;
  scope: "global" | "tenant";
  sensitive: boolean;
  requiresRestart: boolean;
  description?: string;
  kind: string;
}

export interface SettingLeafEntry {
  path: string;
  value: unknown;
  meta: SettingLeafMeta;
}

export interface SettingsListResponse {
  items: SettingLeafEntry[];
  diagnostics: {
    pending_restart_keys: string[];
    override_keys: string[];
  };
}

export interface SettingPutResult {
  value: unknown;
  requiresRestart: boolean;
}

export interface EngineRestartStatus {
  boot_id: string;
  started_at: string;
  saved_revision: number;
  active_revision: number;
  activation_status: string;
  restart_supervised: boolean;
  pending_restart_fields: string[];
}

export interface EngineRestartAccepted {
  request_id: string;
  audit_id: string;
  boot_id: string;
  expected_revision: number;
}

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
  ): Promise<SettingsListResponse> {
    const { data } = await this.api.GET("/v1/settings", {
      params: { query: opts.tenant ? { tenant: opts.tenant } : {} },
    });
    return data as SettingsListResponse;
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

  setSetting(
    this: EngineClient,
    path: string,
    value: unknown,
    opts: { tenant?: string; force?: boolean } = {},
  ): Promise<SettingPutResult> {
    const qs = opts.tenant ? `?tenant=${encodeURIComponent(opts.tenant)}` : "";
    const body: Record<string, unknown> = { value };
    if (opts.force) body.force = true;
    return this.request(
      "PUT",
      `/v1/settings/${encodeURIComponent(path)}${qs}`,
      body,
      undefined,
      undefined,
      { [AUDIT_SOURCE_HEADER]: SK_CLI_AUDIT_SOURCE },
    );
  },
};
