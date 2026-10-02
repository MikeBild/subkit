import { useQuery } from "@tanstack/react-query";
import { Bot, KeyRound, SearchCheck, ShieldCheck } from "lucide-react";
import { apiRequest } from "@/api/client";
import { absolute } from "@/app/links";
import { Button } from "@/components/ui/button";
import { type ConnectorAuthState, needsRenewal } from "@/lib/connector-auth-state";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { type Remedy, remedyFor } from "@/lib/remedy";
import { FAILED_RUN_STATUSES } from "@/pages/runs-model";

type DetailResource = "connectors" | "knowledge" | "skills" | "files";

const ICONS: Record<Remedy["kind"], typeof Bot> = {
  review_repair: ShieldCheck,
  grant: ShieldCheck,
  reauth: KeyRound,
  check_auth: KeyRound,
  open_run: SearchCheck,
  chat: Bot,
};

/** A remedy as the action beside a record's title. */
export function RemedyLink({ remedy }: { remedy: Remedy }) {
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
 * A workflow page's ordinary action, for when its automation state asks for
 * nothing: a failed newest run → investigate it (its page names a lost sign-in
 * and leads to the connector); otherwise a conversation that opens with the
 * intent to change this workflow.
 *
 * What the automation state asks for — approving, applying a saved change,
 * repairing — is decided by `lib/automation-state.ts` and takes precedence;
 * the page shows this only when that has no pending step.
 *
 * Only reads the page already makes. Which connector keeps an environment from
 * running is asked when the run dialog opens, not on every page view: the
 * authority preview is a full review.
 */
export function useWorkflowRemedy(
  workflowId: string,
  name: string,
  permissions: readonly string[],
): Remedy | null {
  const { t } = useI18n();
  // The same read as the recent runs on the page.
  const recent = useQuery({
    queryKey: ["workflow-recent-runs", workflowId],
    enabled: permissions.includes("execution:read"),
    queryFn: () =>
      apiRequest<{ items?: { id: string; status: string }[] }>(
        `/v1/executions?workflow_id=${encodeURIComponent(workflowId)}&limit=5`,
      ),
  });
  const newest = recent.data?.items?.[0];
  return remedyFor({
    workflowId,
    failedRunId: newest && FAILED_RUN_STATUSES.has(newest.status) ? newest.id : null,
    canRun: permissions.includes("workflow:run"),
    canChat: permissions.includes("conversation:write"),
    prompt: t("detail.changePrompt", { name }),
  });
}

/**
 * The action beside a record's title, chosen by its state — never a fixed
 * chat button that filled its own label in as the question. A workflow's is
 * chosen on its own page (`workflow-page.tsx`), from its automation state.
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
  if (resource === "connectors") {
    // A lost sign-in is the one thing only a person can fix here; otherwise
    // "Verbindung testen" already stands beside the title.
    if (!connectorAuth || !needsRenewal(connectorAuth)) return null;
    const remedy = remedyFor({
      authState: { connectorId: id, state: connectorAuth, section: "credentials" },
      canRun: false,
      canChat: false,
    });
    return remedy ? <RemedyLink remedy={remedy} /> : null;
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
  return remedy ? <RemedyLink remedy={remedy} /> : null;
}
