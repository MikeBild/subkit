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
  requestEngineRestart(this: EngineClient): Promise<EngineRestartAccepted> {
    return this.request("POST", "/v1/system/restart");
  },

  getEngineRestartStatus(this: EngineClient): Promise<EngineRestartStatus> {
    return this.request("GET", "/v1/system/restart-status");
  },

  listSettings(this: EngineClient, opts: { tenant?: string } = {}): Promise<SettingsListResponse> {
    const qs = opts.tenant ? `?tenant=${encodeURIComponent(opts.tenant)}` : "";
    return this.request("GET", `/v1/settings${qs}`);
  },

  getSetting(
    this: EngineClient,
    path: string,
    opts: { tenant?: string } = {},
  ): Promise<SettingLeafEntry> {
    const qs = opts.tenant ? `?tenant=${encodeURIComponent(opts.tenant)}` : "";
    return this.request("GET", `/v1/settings/${encodeURIComponent(path)}${qs}`);
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
