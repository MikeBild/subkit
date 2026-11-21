import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { SettingsRow } from "@ui/molecules/settings-row";
import { Users } from "lucide-react";
import { useId } from "react";
import {
  APPROVAL_POLICY_KEY,
  type ApprovalPolicy,
  useApprovalPolicy,
  type WorkflowApprovals,
  writeApprovalPolicy,
} from "@/api/approval-policy";
import { SETUP_KEY } from "@/api/setup";
import { useSession } from "@/app/session";
import { Switch } from "@/components/cockpit/patterns";
import { needsTwoApprovers, pairVisibility } from "@/features/operations";
import { errorRows } from "@/lib/error-rows";
import { useI18n } from "@/lib/i18n-context";
import {
  nextPolicy,
  POLICY_PERMISSION,
  policyErrorRows,
  policyView,
} from "./approval-policy-model";

export function ApprovalPolicyRow() {
  const session = useSession();
  const client = useQueryClient();
  const admin = session.permissions.includes(POLICY_PERMISSION);
  const policy = useApprovalPolicy(admin);
  const change = useMutation({
    mutationFn: (next: WorkflowApprovals) => writeApprovalPolicy(next),
    onSuccess: async (stored) => {
      client.setQueryData(APPROVAL_POLICY_KEY, stored);
      await client.invalidateQueries({ queryKey: SETUP_KEY });
    },
  });
  if (!admin || !policy.data || !pairVisibility(policy.data).setting) return null;
  return (
    <ApprovalPolicyPanel
      policy={policy.data}
      permissions={session.permissions}
      busy={change.isPending}
      error={change.isError ? change.error : null}
      onChange={(on) => change.mutate(nextPolicy(on))}
      onRetry={() => change.variables && change.mutate(change.variables)}
    />
  );
}

export function ApprovalPolicyPanel({
  policy,
  permissions,
  busy,
  error,
  onChange,
  onRetry,
}: {
  policy: ApprovalPolicy;
  permissions: readonly string[];
  busy: boolean;
  error: unknown;
  onChange: (on: boolean) => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const view = policyView(policy, permissions, busy, t);
  const twoMissing = needsTwoApprovers(error);
  return (
    <SettingsRow
      id={id}
      icon={Users}
      label={t("approvalPolicy.label")}
      hint={view.hint}
      testId="settings-approval-policy"
      below={
        error ? (
          <ErrorNotice
            testId="settings-approval-policy-failed"
            kind={twoMissing ? "pair_needs_two_approvers" : "settingNotSaved"}
            title={t("approvalPolicy.failed")}
            body={t(twoMissing ? "approvalPolicy.needsTwo" : "approvalPolicy.failedBody")}
            primary={
              twoMissing
                ? undefined
                : {
                    label: t("pattern.retry"),
                    onClick: onRetry,
                    testId: "settings-approval-policy-retry",
                  }
            }
            rows={twoMissing ? policyErrorRows(error, t) : errorRows(error, t)}
          />
        ) : undefined
      }
    >
      <Switch
        id={id}
        checked={view.on}
        disabled={view.disabled}
        onCheckedChange={onChange}
        data-testid="settings-approval-policy-switch"
      />
    </SettingsRow>
  );
}
