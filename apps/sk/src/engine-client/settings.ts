// Settings surfaces of the engine client. Settings writes are tagged
// with the sk-cli audit source so compliance review can distinguish
// operator-driven writes from the deploy-body bootstrap path. Method
// group merged into `EngineClient` by `../engine-client.ts`.

import { AUDIT_SOURCE_HEADER, type AuditSource } from "@shared/audit-source.ts";

import type { EngineClient } from "../engine-client.ts";

/** The CLI's channel tag on audit_log.metadata.audit_source. The
 *  engine validates against `AUDIT_SOURCE_VALUES` (shared package)
 *  at the route boundary; this constant just narrows the union to
 *  the value sk uses. */
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

export const settingsMethods = {
  // --------------------------- Settings -----------------------------------
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
    // Tag the audit row with audit_source=sk_cli so compliance review
    // can distinguish operator-driven settings writes from the
    // deploy-body bootstrap path. Header name + value come from
    // `@shared/audit-source` — same module the engine route boundary
    // (apps/engine/src/audit/audit-source.ts) imports from. A future
    // rename of either lands in one place and propagates here.
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
