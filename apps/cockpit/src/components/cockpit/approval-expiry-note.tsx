import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiCall } from "@/api/call";
import { type ConnectorEnvironment, EnvironmentChip } from "@/components/cockpit/environment-chip";
import { Button, STATUS_DOT } from "@/components/cockpit/patterns";
import { approvalExpiryDays, approvalExpiryKey } from "@/lib/approval-expiry";
import { useI18n } from "@/lib/i18n-context";
import { taskKeys } from "@/lib/task-keys";
import { cn } from "@/lib/utils";

export function ApprovalExpiryNote({
  validUntil,
  environment,
  onRenew,
  testId = "approval-expiry-strip",
}: {
  validUntil: string | null | undefined;
  environment?: ConnectorEnvironment;
  onRenew?: () => void;
  testId?: string;
}) {
  const { t } = useI18n();
  const [now] = useState(() => Date.now());
  const days = approvalExpiryDays(validUntil, now);
  if (days === null) return null;
  return (
    <span
      className="inline-flex min-w-0 flex-wrap items-center gap-2 text-sm"
      data-testid={testId}
      data-tone="warn"
    >
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", STATUS_DOT.warn)} />
      <span data-slot="approval-expiry-line">{t(approvalExpiryKey(days), { count: days })}</span>
      {environment ? (
        <EnvironmentChip environment={environment} testId={`${testId}-environment`} />
      ) : null}
      {onRenew ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRenew}
          data-testid={`${testId}-renew`}
        >
          {t("approvalExpiry.renew")}
        </Button>
      ) : null}
    </span>
  );
}

export function useTaskGrantExpiry(taskId: string, enabled: boolean) {
  const preview = useQuery({
    queryKey: taskKeys.grantPreview(taskId),
    queryFn: () => apiCall("get", "/v1/tasks/{id}/grant-preview", { path: { id: taskId } }),
    enabled,
  });
  const grant = preview.data?.live_grant ?? null;
  return {
    loading: enabled && preview.isPending,
    validUntil: grant?.valid_until ?? null,
    environment: grant?.environment,
  };
}
