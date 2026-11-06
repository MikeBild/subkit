import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import {
  apiKeys,
  connectors,
  knowledgeSources,
  portalTokens,
  skills,
  subscriptions,
  workflows,
} from "../../db/schema/index.ts";

export type ResourceLookup = (db: Executor, tenant_id: string, id: string) => Promise<boolean>;

export const RESOURCE_LOOKUPS: Readonly<Record<string, ResourceLookup>> = {
  workflow: async (db, tenant_id, id) =>
    (
      await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.tenant_id, tenant_id),
            eq(workflows.id, id),
            isNull(workflows.deleted_at),
          ),
        )
        .limit(1)
    ).length > 0,
  connector: async (db, tenant_id, id) =>
    (
      await db
        .select({ id: connectors.id })
        .from(connectors)
        .where(
          and(
            eq(connectors.tenant_id, tenant_id),
            eq(connectors.id, id),
            isNull(connectors.deleted_at),
          ),
        )
        .limit(1)
    ).length > 0,
  knowledge: async (db, tenant_id, id) => knowledgeSourceExists(db, tenant_id, id),
  knowledge_source: async (db, tenant_id, id) => knowledgeSourceExists(db, tenant_id, id),
  skill: async (db, tenant_id, id) =>
    (
      await db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
        .limit(1)
    ).length > 0,
  subscription: async (db, tenant_id, id) =>
    (
      await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(and(eq(subscriptions.tenant_id, tenant_id), eq(subscriptions.id, id)))
        .limit(1)
    ).length > 0,
  api_key: async (db, tenant_id, id) =>
    (
      await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.tenant_id, tenant_id), eq(apiKeys.id, id)))
        .limit(1)
    ).length > 0,
  portal_token: async (db, tenant_id, id) =>
    (
      await db
        .select({ id: portalTokens.id })
        .from(portalTokens)
        .where(and(eq(portalTokens.tenant_id, tenant_id), eq(portalTokens.id, id)))
        .limit(1)
    ).length > 0,
};

async function knowledgeSourceExists(
  db: Executor,
  tenant_id: string,
  id: string,
): Promise<boolean> {
  return (
    (
      await db
        .select({ id: knowledgeSources.id })
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.tenant_id, tenant_id),
            eq(knowledgeSources.id, id),
            isNull(knowledgeSources.deleted_at),
          ),
        )
        .limit(1)
    ).length > 0
  );
}
