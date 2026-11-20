import type { AllowList, ResolvedPrincipal } from "../../auth/types.ts";
import type { DraftDocument, TaskRunMarker } from "../types.ts";

function narrowed(existing: AllowList | undefined, bound: readonly string[]): string[] {
  if (existing === undefined || existing === "all") return [...bound];
  return bound.filter((id) => existing.includes(id));
}

export function taskRunPrincipal(
  principal: ResolvedPrincipal,
  marker: TaskRunMarker,
): ResolvedPrincipal {
  return {
    ...principal,
    allowed_workflows: narrowed(
      principal.allowed_workflows,
      marker.sealed ? [] : marker.workflow_ids,
    ),
    allowed_connectors: narrowed(
      principal.allowed_connectors,
      marker.sealed ? [] : marker.connector_ids,
    ),
  };
}

function storedMarkerValue(draft: unknown): unknown {
  if (!draft || typeof draft !== "object") return undefined;
  const session = (draft as { session?: unknown }).session;
  if (!session || typeof session !== "object") return undefined;
  return (session as { task_run?: unknown }).task_run;
}

export function withStoredTaskRunMarker<T extends DraftDocument>(next: T, stored: unknown): T {
  const marker = storedMarkerValue(stored);
  if (marker !== undefined)
    return { ...next, session: { ...(next.session ?? {}), task_run: marker as TaskRunMarker } };
  if (!next.session || !("task_run" in next.session)) return next;
  const { task_run: _dropped, ...session } = next.session;
  return { ...next, session };
}

export function withTaskRunMarker<T extends DraftDocument>(
  next: T,
  marker: TaskRunMarker | null | undefined,
): T {
  if (!marker) return next;
  return { ...next, session: { ...(next.session ?? {}), task_run: marker } };
}
