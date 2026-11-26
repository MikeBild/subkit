import pc from "picocolors";
import type { EngineClient } from "../engine-client.ts";
import { cockpitUrl } from "./intake-review.ts";

type StatusClient = Pick<EngineClient, "base" | "getWorkflowAutomationStatus">;

export function hookApprovalNotice(client: Pick<EngineClient, "base">, workflowId: string): string {
  const approve = cockpitUrl(client, `workflows/${encodeURIComponent(workflowId)}`);
  return (
    `${pc.yellow("approval:")} signed deliveries to this hook do not run until a person approves runs of the workflow in Cockpit: ${approve}\n` +
    `${pc.dim("Until then each signed delivery is answered 202, kept for 7 days and run once after approval.")}\n`
  );
}

export async function hookApprovalNoticeFor(
  client: StatusClient,
  workflowId: string,
  hookId?: string,
): Promise<string> {
  const status = await client.getWorkflowAutomationStatus(workflowId).catch(() => null);
  if (!Array.isArray(status?.inbound_hooks)) return hookApprovalNotice(client, workflowId);
  const hooks = status.inbound_hooks.filter(
    (hook) => hookId === undefined || hook.inbound_hook_id === hookId,
  );
  if (hookId === undefined && hooks.length === 0) return "";
  if (hooks.length > 0 && hooks.every((hook) => hook.ready)) return "";
  return hookApprovalNotice(client, workflowId);
}
