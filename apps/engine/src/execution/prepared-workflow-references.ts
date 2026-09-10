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
  const ids = new Set<string>();
  const slugs = new Map<string, boolean>();
  function walk(value: unknown): void {
    if (typeof value === "string") {
      for (const token of parsePlaceholders(value).tokens) {
        if (token.slug)
          slugs.set(token.slug, token.kind === "cred" || slugs.get(token.slug) === true);
      }
    } else if (Array.isArray(value)) {
      for (const child of value) walk(child);
    } else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (object.kind === "request" && typeof object.connector_id === "string") {
        if (!z.string().uuid().safeParse(object.connector_id).success) unavailable();
        ids.add(object.connector_id);
      }
      for (const child of Object.values(object)) walk(child);
    }
    if (ids.size + slugs.size > 1000) unavailable();
  }
  walk(definition);
  const selected = new Map<string, boolean>();
  for (const id of [...ids].sort()) {
    const system = await loadConnectorSystem(tenant, id, environment, db);
    if (!system) unavailable();
    selected.set(system.id, system.connector.auth_type !== "none");
  }
  for (const [slug, needsCredential] of [...slugs].sort(([a], [b]) => a.localeCompare(b))) {
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
    if (!row) unavailable();
    selected.set(row.id, needsCredential || selected.get(row.id) === true);
  }
  const result: ResolvedAuthorityReference[] = [];
  for (const [id, needsCredential] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
    const system = await loadConnectorSystem(tenant, id, environment, db);
    if (!system?.connector.enabled || system.connector.needs_reauth) unavailable();
    const metadata = needsCredential ? await system.getAuthorityMetadata() : null;
    if (needsCredential && !metadata?.available) unavailable();
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

function unavailable(): never {
  throw Object.assign(
    new Error(
      "Workflow access changed or cannot be prepared; review its connectors and prepare again.",
    ),
    {
      code: "prepared_credential_unavailable",
    },
  );
}
