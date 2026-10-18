import type { ResolvedPrincipal } from "../auth/types.ts";
import { type ConfigLeaf, findLeafByPath } from "../config/walk.ts";
import type { Executor } from "../db/client.ts";
import { principalHolds as holds } from "../rbac/evaluator.ts";
import type { SettingsView } from "./settings-read.ts";

const SETTINGS_READ_GLOBAL = "settings:read:global";
const SETTINGS_WRITE_GLOBAL = "settings:write:global";

export type SettingsDenial = {
  ok: false;
  code: "scope_violation" | "operator_required";
  message: string;
};

export type SettingWriteTarget =
  | { kind: "engine" }
  | { kind: "tenant"; tenantId: string; restricted: boolean };

function ownWorkspaceOnly(principal: ResolvedPrincipal): SettingsDenial {
  return {
    ok: false,
    code: "scope_violation",
    message: `You can read and change settings only for your own workspace (${principal.tenant_id}).`,
  };
}

function engineOnly(path: string): SettingsDenial {
  return {
    ok: false,
    code: "operator_required",
    message: `${path} applies to the whole engine. Only the engine operator can change it. Ask your engine operator.`,
  };
}

export function engineOnlyReadDenial(path: string, view: SettingsView): SettingsDenial | null {
  if (view.kind !== "tenant") return null;
  const leaf = findLeafByPath(path);
  if (!leaf || leaf.meta.scope === "tenant") return null;
  return engineOnly(path);
}

export async function resolveSettingsReadView(
  db: Executor,
  principal: ResolvedPrincipal,
  tenant: string | undefined,
): Promise<{ ok: true; view: SettingsView } | SettingsDenial> {
  if (await holds(db, principal, SETTINGS_READ_GLOBAL)) {
    return { ok: true, view: tenant ? { kind: "engine", tenantId: tenant } : { kind: "engine" } };
  }
  if (tenant && tenant !== principal.tenant_id) return ownWorkspaceOnly(principal);
  return { ok: true, view: { kind: "tenant", tenantId: principal.tenant_id } };
}

export async function resolveSettingWriteTarget(
  db: Executor,
  principal: ResolvedPrincipal,
  leaf: ConfigLeaf,
  path: string,
  tenant: string | undefined,
): Promise<{ ok: true; target: SettingWriteTarget } | SettingsDenial> {
  const engineWide = await holds(db, principal, SETTINGS_WRITE_GLOBAL);
  if (!tenant) {
    if (engineWide) return { ok: true, target: { kind: "engine" } };
    if (leaf.meta.scope === "tenant") {
      return {
        ok: false,
        code: "operator_required",
        message: `${path} without a tenant changes the whole engine. To change it for your workspace only, send ?tenant=<your tenant id> (sk settings set ${path} --tenant ${principal.tenant_id}).`,
      };
    }
    return engineOnly(path);
  }
  if (leaf.meta.scope !== "tenant") {
    return {
      ok: false,
      code: "scope_violation",
      message: `${path} is scope="global"; cannot be set per-tenant`,
    };
  }
  if (tenant !== principal.tenant_id && !engineWide) return ownWorkspaceOnly(principal);
  return { ok: true, target: { kind: "tenant", tenantId: tenant, restricted: !engineWide } };
}
