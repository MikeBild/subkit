import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { loadConnectorSystem } from "../connectors/system.ts";
import type { Executor } from "../db/client.ts";
import { connectors } from "../db/schema/index.ts";
import { parsePlaceholders } from "../llm/substitution/parser.ts";
import type { ResolvedAuthorityReference } from "../llm/substitution/resolver.ts";
import { authorityConnectorDigest } from "../workflows/authority-configuration.ts";
import { workflowJsonDigest } from "../workflows/canonical-json.ts";
import type { WorkflowDef } from "../workflows/types.ts";
import {
  type ConnectorUnavailability,
  connectorUnavailability,
  type PreparedReferenceRefusal,
  preparedReferenceRefusalMessage,
} from "./connector-availability.ts";

/** Metadata-only, execution-wide baseline for a prepared single-run decision.
 * Include references in transforms and earlier reads, not just the eventual
 * write. The runtime proof and dispatch recheck use the same finite set.
 * No token is decrypted and no OAuth exchange is started here. */
export async function capturePreparedWorkflowReferences(
  db: Executor,
  tenant: string,
  environment: "dev" | "prod",
  definition: WorkflowDef,
): Promise<ResolvedAuthorityReference[]> {
  const refuse = (
    reason: ConnectorUnavailability,
    at: Partial<Omit<PreparedReferenceRefusal, "environment" | "reason">> = {},
  ): never =>
    unavailable({
      step_id: at.step_id ?? null,
      connector_id: at.connector_id ?? null,
      connector_slug: at.connector_slug ?? null,
      connector_name: at.connector_name ?? null,
      environment,
      reason,
    });
  // Which step first needs each reference, so a refusal can name it. The
  // reference set itself does not depend on this.
  const ids = new Map<string, string | null>();
  const slugs = new Map<string, { credential: boolean; step_id: string | null }>();
  function walk(value: unknown, step_id: string | null): void {
    if (typeof value === "string") {
      for (const token of parsePlaceholders(value).tokens) {
        if (!token.slug) continue;
        const seen = slugs.get(token.slug);
        slugs.set(token.slug, {
          credential: token.kind === "cred" || seen?.credential === true,
          step_id: seen ? seen.step_id : step_id,
        });
      }
    } else if (Array.isArray(value)) {
      for (const child of value) walk(child, step_id);
    } else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (object.kind === "request" && typeof object.connector_id === "string") {
        if (!z.string().uuid().safeParse(object.connector_id).success)
          refuse("missing", { step_id });
        if (!ids.has(object.connector_id)) ids.set(object.connector_id, step_id);
      }
      for (const child of Object.values(object)) walk(child, step_id);
    }
    if (ids.size + slugs.size > 1000) refuse("too_many_references", { step_id });
  }
  // Step by step so a refusal knows its step; then everything outside the
  // steps (an output transform can reference a connector too).
  for (const step of definition.steps) walk(step, step.id);
  walk({ ...definition, steps: [] }, null);
  const selected = new Map<string, boolean>();
  // Keyed by the connector resolved in this environment — the twin, not the
  // authored id — so the refusal names the connector that has to be fixed.
  const stepFor = new Map<string, string | null>();
  for (const [id, step_id] of [...ids].sort(([a], [b]) => a.localeCompare(b))) {
    const system = await loadConnectorSystem(tenant, id, environment, db);
    if (!system) return refuse("missing", { step_id, connector_id: id });
    selected.set(system.id, system.connector.auth_type !== "none");
    if (!stepFor.has(system.id)) stepFor.set(system.id, step_id);
  }
  for (const [slug, reference] of [...slugs].sort(([a], [b]) => a.localeCompare(b))) {
    const [row] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.tenant_id, tenant),
          eq(connectors.slug, slug),
          eq(connectors.environment, environment),
          isNull(connectors.deleted_at),
        ),
      )
      .limit(1);
    if (!row) return refuse("missing", { step_id: reference.step_id, connector_slug: slug });
    selected.set(row.id, reference.credential || selected.get(row.id) === true);
    if (!stepFor.has(row.id)) stepFor.set(row.id, reference.step_id);
  }
  const result: ResolvedAuthorityReference[] = [];
  for (const [id, needsCredential] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
    const step_id = stepFor.get(id) ?? null;
    const system = await loadConnectorSystem(tenant, id, environment, db);
    if (!system) return refuse("missing", { step_id, connector_id: id });
    const metadata = needsCredential ? await system.getAuthorityMetadata() : null;
    const reason = connectorUnavailability(system.connector, metadata, needsCredential);
    if (reason)
      refuse(reason, {
        step_id,
        connector_id: system.id,
        connector_slug: system.connector.slug,
        connector_name: system.connector.display_name,
      });
    result.push({
      connector_id: system.id,
      configuration_digest: authorityConnectorDigest(system.connector),
      credential_id: metadata?.binding.primary?.id ?? null,
      credential_revision: metadata?.binding.primary?.revision ?? null,
      ...(metadata ? { credential_binding_digest: workflowJsonDigest(metadata.binding) } : {}),
      connection_authority: metadata?.binding.connection
        ? { id: metadata.binding.connection.id, revision: metadata.binding.connection.revision }
        : null,
    });
  }
  return result;
}

function unavailable(details: PreparedReferenceRefusal): never {
  throw Object.assign(new Error(preparedReferenceRefusalMessage(details)), {
    code: "prepared_credential_unavailable",
    details,
  });
}
