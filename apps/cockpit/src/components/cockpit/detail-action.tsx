import { useQuery } from "@tanstack/react-query";
import { Bot, KeyRound, SearchCheck, ShieldCheck } from "lucide-react";
import { apiRequest } from "@/api/client";
import { listHeldInboundHooks, listHeldSchedules } from "@/api/decisions";
import { absolute } from "@/app/links";
import { Button } from "@/components/ui/button";
import { type ConnectorAuthState, needsRenewal } from "@/lib/connector-auth-state";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { type Remedy, remedyFor } from "@/lib/remedy";
import { FAILED_RUN_STATUSES } from "@/pages/runs-model";

type DetailResource = "workflows" | "connectors" | "knowledge" | "skills" | "files";

const ICONS: Record<Remedy["kind"], typeof Bot> = {
  review_repair: ShieldCheck,
  grant: ShieldCheck,
  reauth: KeyRound,
  check_auth: KeyRound,
  open_run: SearchCheck,
  chat: Bot,
};

function ActionLink({ remedy }: { remedy: Remedy }) {
  const { t } = useI18n();
  const Icon = ICONS[remedy.kind];
  // On a record's own page the conversation is where the record is changed;
  // "fix it" would presume something is broken.
  const label: TranslationKey = remedy.kind === "chat" ? "detail.changeInChat" : remedy.labelKey;
  return (
    <Button asChild variant="outline">
      <a href={absolute(remedy.href)} data-testid="detail-action">
        <Icon data-icon="inline-start" />
        {t(label)}
      </a>
    </Button>
  );
}

/**
 * The next step a workflow's state asks for, in `remedyFor`'s order: a held
 * schedule or webhook → review the approval; a failed newest run → investigate
 * it (its page names a lost sign-in and leads to the connector); otherwise a
 * conversation that opens with the intent to change this workflow.
 *
 * Only reads the page already makes. Which connector keeps an environment from
 * running is asked when the run dialog opens, not on every page view: the
 * authority preview is a full review, and the approval section counts on it
 * being asked only for what a reviewer chose.
 */
function WorkflowAction({
  workflowId,
  name,
  permissions,
}: {
  workflowId: string;
  name: string;
  permissions: readonly string[];
}) {
  const { t } = useI18n();
  // The same reads, under the same keys, as the approval section below.
  const scheduleHolds = useQuery({
    queryKey: ["workflow-schedule-holds"],
    queryFn: listHeldSchedules,
    refetchInterval: 30_000,
    retry: false,
  });
  const hookHolds = useQuery({
    queryKey: ["workflow-automation-status", workflowId, "held-hooks"],
    queryFn: () => listHeldInboundHooks(workflowId),
    refetchInterval: 30_000,
    retry: false,
  });
  const held =
    Boolean(scheduleHolds.data?.some((schedule) => schedule.workflow_id === workflowId)) ||
    (hookHolds.data?.length ?? 0) > 0;
  const canReadRuns = permissions.includes("execution:read");
  // The same read as the recent runs below.
  const recent = useQuery({
    queryKey: ["workflow-recent-runs", workflowId],
    enabled: canReadRuns,
    queryFn: () =>
      apiRequest<{ items?: { id: string; status: string }[] }>(
        `/v1/executions?workflow_id=${encodeURIComponent(workflowId)}&limit=5`,
      ),
  });
  const newest = recent.data?.items?.[0];
  const remedy = remedyFor({
    workflowId,
    held,
    failedRunId: newest && FAILED_RUN_STATUSES.has(newest.status) ? newest.id : null,
    canRun: permissions.includes("workflow:run"),
    canChat: permissions.includes("conversation:write"),
    prompt: t("detail.changePrompt", { name }),
  });
  return remedy ? <ActionLink remedy={remedy} /> : null;
}

/**
 * The action beside a record's title, chosen by its state — never a fixed
 * chat button that filled its own label in as the question.
 */
export function DetailAction({
  resource,
  id,
  name,
  connectorAuth,
  permissions,
}: {
  resource: DetailResource;
  id: string;
  name: string;
  connectorAuth: ConnectorAuthState | null;
  permissions: readonly string[];
}) {
  if (resource === "workflows")
    return <WorkflowAction workflowId={id} name={name} permissions={permissions} />;
  if (resource === "connectors") {
    // A lost sign-in is the one thing only a person can fix here; otherwise
    // "Verbindung testen" already stands beside the title.
    if (!connectorAuth || !needsRenewal(connectorAuth)) return null;
    const remedy = remedyFor({
      authState: { connectorId: id, state: connectorAuth, section: "credentials" },
      canRun: false,
      canChat: false,
    });
    return remedy ? <ActionLink remedy={remedy} /> : null;
  }
  if (resource === "files") return null;
  return <RecordChatAction name={name} permissions={permissions} />;
}

function RecordChatAction({ name, permissions }: { name: string; permissions: readonly string[] }) {
  const { t } = useI18n();
  const remedy = remedyFor({
    canRun: false,
    canChat: permissions.includes("conversation:write"),
    prompt: t("detail.changeRecordPrompt", { name }),
  });
  return remedy ? <ActionLink remedy={remedy} /> : null;
}
