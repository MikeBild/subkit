import { z } from "@hono/zod-openapi";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { connectors } from "../db/schema/index.ts";

type Environment = "dev" | "prod";

export interface MissingConnectorReference {
  step_id: string;
  connector_id: string;
}

export interface UnboundStep extends MissingConnectorReference {
  state: "deleted" | "not_found";
  connector_slug?: string;
  driver?: string;
  replacement?: { connector_id: string; connector_slug: string; environment: Environment };
  call_path?: string[];
}

export const MissingBindingEvidenceSchema = z
  .object({
    kind: z.enum(["connector"]),
    state: z.enum(["deleted", "not_found", "unresolved"]),
    environment: z.enum(["dev", "prod"]),
    reference: z
      .object({
        connector_id: z.string().uuid().optional(),
        connector_slug: z.string().optional(),
        driver: z.string().optional(),
      })
      .strict(),
    replacement: z
      .object({
        connector_id: z.string().uuid(),
        connector_slug: z.string(),
        environment: z.enum(["dev", "prod"]),
      })
      .strict()
      .optional(),
    call_step_id: z.string().optional(),
    repair: z.enum(["rebind_connector", "restore_connector", "repair_called_workflow"]),
  })
  .strict()
  .openapi("MissingBindingEvidence", {
    description:
      "What a missing_binding step lacks: the kind of binding, the reference the step names and whether it was deleted or never existed in this workspace, a live connector with the same slug and driver when one exists, and the repair path.",
  });
export type MissingBindingEvidence = z.infer<typeof MissingBindingEvidenceSchema>;

interface ConnectorRow {
  id: string;
  slug: string;
  driver: string;
  environment: Environment;
  deleted: boolean;
}

export function classifyUnboundSteps(
  missing: readonly MissingConnectorReference[],
  rows: readonly ConnectorRow[],
  environment: Environment,
): UnboundStep[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const live = rows
    .filter((row) => !row.deleted)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return missing.map((reference): UnboundStep => {
    const row = byId.get(reference.connector_id);
    if (!row) return { ...reference, state: "not_found" };
    const sameSlug = live.filter(
      (candidate) =>
        candidate.id !== row.id && candidate.slug === row.slug && candidate.driver === row.driver,
    );
    const replacement =
      sameSlug.find((candidate) => candidate.environment === environment) ?? sameSlug[0];
    return {
      ...reference,
      state: row.deleted ? "deleted" : "not_found",
      connector_slug: row.slug,
      driver: row.driver,
      ...(replacement
        ? {
            replacement: {
              connector_id: replacement.id,
              connector_slug: replacement.slug,
              environment: replacement.environment,
            },
          }
        : {}),
    };
  });
}

export async function describeUnboundSteps(
  db: Executor,
  tenant_id: string,
  environment: Environment,
  missing: readonly MissingConnectorReference[],
): Promise<UnboundStep[]> {
  if (missing.length === 0) return [];
  const ids = [...new Set(missing.map((reference) => reference.connector_id))];
  const columns = {
    id: connectors.id,
    slug: connectors.slug,
    driver: connectors.driver,
    environment: connectors.environment,
    deleted_at: connectors.deleted_at,
  };
  const referenced = await db
    .select(columns)
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenant_id), inArray(connectors.id, ids)));
  const slugs = [...new Set(referenced.map((row) => row.slug))];
  const live =
    slugs.length === 0
      ? []
      : await db
          .select(columns)
          .from(connectors)
          .where(
            and(
              eq(connectors.tenant_id, tenant_id),
              inArray(connectors.slug, slugs),
              isNull(connectors.deleted_at),
            ),
          );
  const rows = new Map<string, ConnectorRow>();
  for (const row of [...referenced, ...live])
    rows.set(row.id, {
      id: row.id,
      slug: row.slug,
      driver: row.driver,
      environment: row.environment,
      deleted: row.deleted_at !== null,
    });
  return classifyUnboundSteps(missing, [...rows.values()], environment);
}

export function missingBindingEvidence(
  issue: { step_id: string; call_path?: readonly string[] | undefined },
  unbound: readonly UnboundStep[],
  environment: Environment,
): MissingBindingEvidence {
  const call_step_id = issue.call_path?.[0];
  const entry = unbound.find(
    (candidate) => candidate.step_id === issue.step_id && candidate.call_path?.[0] === call_step_id,
  );
  const repair = call_step_id
    ? "repair_called_workflow"
    : entry?.state === "deleted" && !entry.replacement
      ? "restore_connector"
      : "rebind_connector";
  return {
    kind: "connector",
    state: entry?.state ?? "unresolved",
    environment,
    reference: entry
      ? {
          connector_id: entry.connector_id,
          ...(entry.connector_slug ? { connector_slug: entry.connector_slug } : {}),
          ...(entry.driver ? { driver: entry.driver } : {}),
        }
      : {},
    ...(entry?.replacement ? { replacement: entry.replacement } : {}),
    ...(call_step_id ? { call_step_id } : {}),
    repair,
  };
}
