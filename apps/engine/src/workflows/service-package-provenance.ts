import { and, desc, eq, like } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflowVersions } from "../db/schema/index.ts";

export interface ServicePackageWorkflowSource {
  package_id: string;
  package_version: string;
  connector_id: string;
  workflow_slug: string;
  prefix: string;
  artifact_hash: string;
  definition_hash: string;
}

export interface ServicePackageWorkflowProvenance extends ServicePackageWorkflowSource {
  installed_hash: string;
}

const NOTE_PREFIX = "subkit-service-package-workflow/v1:";

export function packageWorkflowNote(
  source: ServicePackageWorkflowSource,
  installedHash: string,
): string {
  const value: ServicePackageWorkflowProvenance = {
    ...source,
    installed_hash: installedHash,
  };
  return `${NOTE_PREFIX}${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

export function parsePackageWorkflowNote(
  value: string | null,
): ServicePackageWorkflowProvenance | null {
  if (!value?.startsWith(NOTE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value.slice(NOTE_PREFIX.length), "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object") return null;
    const item = parsed as Record<string, unknown>;
    if (
      typeof item.package_id !== "string" ||
      typeof item.package_version !== "string" ||
      typeof item.connector_id !== "string" ||
      typeof item.workflow_slug !== "string" ||
      typeof item.prefix !== "string" ||
      typeof item.artifact_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.artifact_hash) ||
      typeof item.definition_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.definition_hash) ||
      typeof item.installed_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.installed_hash)
    ) {
      return null;
    }
    return item as unknown as ServicePackageWorkflowProvenance;
  } catch {
    return null;
  }
}

export async function findPackageWorkflowProvenance(
  exec: Executor,
  tenant_id: string,
  workflow_id: string,
  matches: (source: ServicePackageWorkflowProvenance) => boolean,
): Promise<ServicePackageWorkflowProvenance | null> {
  const notes = await exec
    .select({ note: workflowVersions.note })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, tenant_id),
        eq(workflowVersions.workflow_id, workflow_id),
        like(workflowVersions.note, `${NOTE_PREFIX}%`),
      ),
    )
    .orderBy(desc(workflowVersions.version));
  for (const row of notes) {
    const source = parsePackageWorkflowNote(row.note);
    if (source && matches(source)) return source;
  }
  return null;
}
