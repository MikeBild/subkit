import { eq } from "drizzle-orm";
import { tenants } from "../db/schema/index.ts";
import { workspaceAiAccess } from "../llm/runtime/workspace-access.ts";
import type { TenantReader } from "./attention-readers.ts";

const AI_SETTINGS_HREF = "/cockpit/settings?area=ai";

export const readAiAccess: TenantReader = async (db, tenantId) => {
  const [tenant] = await db
    .select({ origin: tenants.origin })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (tenant?.origin !== "self_service") return [];
  const access = workspaceAiAccess({ id: tenantId, origin: tenant.origin });
  if (access.own_key) return [];
  return [
    {
      source: "ai_access",
      item: {
        id: "ai-access",
        class: access.configured ? "decide" : "stopped",
        severity: access.configured ? "notice" : "critical",
        kind: access.configured ? "operator_allowance" : "no_access",
        subject: { kind: "settings", id: tenantId, name: "AI access" },
        reason: "ai_access_missing",
        trigger: null,
        cause_class: null,
        counts: {},
        since: null,
        deadline: null,
        detail: access.configured
          ? "This workspace has no API key of its own and uses the operator's allowance."
          : "Without an API key, chat and workflows cannot work.",
        actions: [
          {
            verb: "open",
            href: AI_SETTINGS_HREF,
            primary: true,
            permission: "identity:write",
          },
        ],
      },
    },
  ];
};
