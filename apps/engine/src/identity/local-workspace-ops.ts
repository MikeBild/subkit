import { and, count, eq, inArray } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { setConfigKey } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { executions, taskRuns } from "../db/schema/index.ts";
import { type LlmAccessProbe, probeLlmAccess } from "../llm/runtime/access-probe.ts";
import { workspaceKeyModel } from "../llm/runtime/workspace-access.ts";
import { storeWorkspaceLlmAccess } from "../runtime-config/llm-access.ts";
import { exportTenantPackage } from "./portability/export.ts";
import { loadStoredPackageArchive } from "./portability/registry.ts";

export const LOCAL_MODEL_SERVER_KEY = "local-model-server";
const MODEL_SERVER_BASE_URL = ["llm", "providers", "openai", "base_url"];

export interface LocalOwnerRef {
  tenant_id: string;
  user_id: string;
}

export type LocalAiAccess =
  | { kind: "provider"; provider: "anthropic" | "openai" | "gemini"; api_key: string }
  | { kind: "model_server"; origin: string; model: string | null };

export type LocalAiRefusal =
  | "llm_key_rejected"
  | "llm_model_unavailable"
  | "llm_provider_unreachable"
  | "llm_provider_unavailable";

const PROBE_REFUSAL = {
  key_rejected: "llm_key_rejected",
  model_unavailable: "llm_model_unavailable",
  unreachable: "llm_provider_unreachable",
  misconfigured: "llm_provider_unavailable",
} as const;

export async function storeLocalAiAccess(
  db: Db,
  owner: LocalOwnerRef,
  access: LocalAiAccess,
  probe: LlmAccessProbe = probeLlmAccess,
): Promise<{ ok: true } | { ok: false; code: LocalAiRefusal }> {
  const actor = {
    tenant_id: owner.tenant_id,
    actor_type: "user" as const,
    actor_id: owner.user_id,
  };
  if (access.kind === "provider") {
    const checked = await probe({
      provider: access.provider,
      api_key: access.api_key,
      model: workspaceKeyModel(access.provider),
    });
    if (!checked.ok) return { ok: false, code: PROBE_REFUSAL[checked.code] };
    await storeWorkspaceLlmAccess(db, {
      tenant_id: owner.tenant_id,
      change: { provider: access.provider, api_key: access.api_key },
      actor,
      source: "local_setup",
    });
    return { ok: true };
  }
  await storeWorkspaceLlmAccess(db, {
    tenant_id: owner.tenant_id,
    change: {
      provider: "openai",
      api_key: LOCAL_MODEL_SERVER_KEY,
      ...(access.model ? { model: access.model } : {}),
    },
    actor,
    source: "local_setup",
  });
  const baseUrl = `${access.origin}/v1`;
  await setConfigKey(MODEL_SERVER_BASE_URL, baseUrl, { force: true });
  await auditAwait(
    {
      ...actor,
      action: AuditAction.SETTINGS_CHANGED,
      resource_type: "setting",
      resource_id: MODEL_SERVER_BASE_URL.join("."),
      after: baseUrl,
      metadata: { scope: "global", source: "local_setup" },
    },
    db,
  );
  return { ok: true };
}

export async function exportLocalWorkspace(
  db: Db,
  owner: LocalOwnerRef,
  input: { server_origin?: string | undefined; engine_version: string },
) {
  const exported = await exportTenantPackage(db, {
    tenant_id: owner.tenant_id,
    actor_type: "user",
    actor_id: owner.user_id,
    request_source: "ui",
    source: { instance: null, engine_version: input.engine_version },
  });
  const archive = await loadStoredPackageArchive(db, owner.tenant_id, exported.file_id);
  await auditAwait(
    {
      tenant_id: owner.tenant_id,
      actor_type: "user",
      actor_id: owner.user_id,
      action: AuditAction.WORKSPACE_MOVED_TO_SERVER,
      resource_type: "tenant",
      resource_id: owner.tenant_id,
      result: "success",
      metadata: {
        ...(input.server_origin ? { server_host: new URL(input.server_origin).host } : {}),
        file_id: exported.file_id,
        content_digest: exported.content_digest,
        items: exported.items_summary,
      },
    },
    db,
  );
  return { file_id: exported.file_id, filename: exported.filename, bytes: archive.bytes };
}

export async function localWorkspaceActivity(db: Db, tenantId: string): Promise<number> {
  const [runs] = await db
    .select({ n: count() })
    .from(executions)
    .where(
      and(eq(executions.tenant_id, tenantId), inArray(executions.status, ["queued", "running"])),
    );
  const [tasks] = await db
    .select({ n: count() })
    .from(taskRuns)
    .where(and(eq(taskRuns.tenant_id, tenantId), eq(taskRuns.state, "running")));
  return (runs?.n ?? 0) + (tasks?.n ?? 0);
}
