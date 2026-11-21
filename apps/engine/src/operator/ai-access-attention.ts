import { eq } from "drizzle-orm";
import { currentDeploymentMode } from "../config/deployment-mode.ts";
import { tenants } from "../db/schema/index.ts";
import { readModelServerCapability } from "../identity/local-model-probe.ts";
import { workspaceAiAccess } from "../llm/runtime/workspace-access.ts";
import type { TenantReader } from "./attention-readers.ts";

const AI_SETTINGS_HREF = "/cockpit/settings?area=ai";

function settingsItem(tenantId: string, reason: "ai_access_missing" | "model_tools_missing") {
  const missing = reason === "ai_access_missing";
  return {
    source: "ai_access" as const,
    item: {
      id: missing ? "ai-access" : "model-tools",
      class: missing ? ("stopped" as const) : ("decide" as const),
      severity: missing ? ("critical" as const) : ("notice" as const),
      kind: "no_access" as const,
      subject: { kind: "settings" as const, id: tenantId, name: "AI access" },
      reason,
      trigger: null,
      cause_class: null,
      counts: {},
      since: null,
      deadline: null,
      detail: missing
        ? "Without an API key, chat and workflows cannot work."
        : "The local model server cannot call tools. Chat and tasks need that; workflows keep running.",
      actions: [
        {
          verb: "open" as const,
          href: AI_SETTINGS_HREF,
          primary: true,
          permission: "identity:write" as const,
        },
      ],
    },
  };
}

export type AiAttentionReason = "ai_access_missing" | "model_tools_missing";

export function aiAttentionReason(input: {
  selfService: boolean;
  local: boolean;
  configured: () => boolean;
  tools: () => Promise<boolean | null>;
}): Promise<AiAttentionReason | null> {
  if (!input.selfService && !input.local) return Promise.resolve(null);
  if (!input.configured()) return Promise.resolve("ai_access_missing");
  if (!input.local) return Promise.resolve(null);
  return input.tools().then((tools) => (tools === false ? "model_tools_missing" : null));
}

export const readAiAccess: TenantReader = async (db, tenantId) => {
  const [tenant] = await db
    .select({ origin: tenants.origin })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) return [];
  const reason = await aiAttentionReason({
    selfService: tenant.origin === "self_service",
    local: currentDeploymentMode() === "local_workspace",
    configured: () => workspaceAiAccess({ id: tenantId, origin: tenant.origin }).configured,
    tools: async () => (await readModelServerCapability(db))?.tools ?? null,
  });
  return reason ? [settingsItem(tenantId, reason)] : [];
};
