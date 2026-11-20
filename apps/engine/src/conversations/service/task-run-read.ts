import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Executor } from "../../db/client.ts";
import { hasBuiltinAdminRole } from "../../rbac/evaluator.ts";
import { readTaskRunScope, type TaskRunScope } from "./task-run-access.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TaskRunReader {
  tenant_id: string;
  conversation_id: string;
  principal: ResolvedPrincipal | null | undefined;
}

export function mayReadTaskRun(
  scope: TaskRunScope | null,
  reader: Pick<TaskRunReader, "tenant_id" | "principal">,
): boolean {
  if (!scope) return true;
  const principal = reader.principal;
  if (!principal || principal.tenant_id !== reader.tenant_id) return false;
  if (hasBuiltinAdminRole(principal)) return true;
  if (scope.marker.sealed) return false;
  return scope.owner_id !== null && scope.owner_id === principal.id;
}

export async function canReadTaskRun(exec: Executor, reader: TaskRunReader): Promise<boolean> {
  if (!UUID.test(reader.conversation_id)) return true;
  const scope = await readTaskRunScope(exec, reader.tenant_id, reader.conversation_id);
  return mayReadTaskRun(scope, reader);
}

export function taskRunListReader(principal: ResolvedPrincipal): string | null {
  return hasBuiltinAdminRole(principal) ? null : principal.id;
}
