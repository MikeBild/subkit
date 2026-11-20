import { apiCall } from "@/api/call";
import { UNCATEGORIZED } from "@/lib/workflow-category";
import type { CatalogKind, MetadataPatch } from "./catalog-metadata-model";

export type CatalogMetadataBody = MetadataPatch & {
  accept_description?: boolean;
  name?: string;
  filename?: string;
  title?: string;
};

export function patchCatalogMetadata(
  kind: CatalogKind,
  id: string,
  body: CatalogMetadataBody,
): Promise<unknown> {
  if (kind === "workflow")
    return apiCall("patch", "/v1/workflows/{id}/metadata", { path: { id }, body });
  if (kind === "connector") return apiCall("patch", "/v1/connectors/{id}", { path: { id }, body });
  if (kind === "knowledge_source")
    return apiCall("patch", "/v1/knowledge-sources/{id}", { path: { id }, body });
  if (kind === "skill") return apiCall("patch", "/v1/skills/{id}", { path: { id }, body });
  if (kind === "task") return patchTaskMetadata(id, body);
  return apiCall("patch", "/v1/files/{id}", { path: { id }, body });
}

async function patchTaskMetadata(id: string, body: CatalogMetadataBody): Promise<unknown> {
  const task = await apiCall("get", "/v1/tasks/{id}", { path: { id } });
  const category = body.category === undefined ? task.category : body.category;
  return apiCall("put", "/v1/tasks/{id}", {
    path: { id },
    body: {
      name: body.name ?? task.name,
      description: body.description === undefined ? task.description : body.description,
      ...(category && category !== UNCATEGORIZED ? { category } : {}),
      goal: task.goal,
      done_when: task.done_when,
      plan: task.plan,
      bindings: task.bindings,
      environment: task.environment,
      schedule_cron: task.schedule_cron,
      schedule_timezone: task.schedule_timezone,
      schedule_run_at: task.schedule_run_at,
      max_turns: task.max_turns,
      run_deadline_minutes: task.run_deadline_minutes,
      expected_revision: task.revision,
    },
  });
}
