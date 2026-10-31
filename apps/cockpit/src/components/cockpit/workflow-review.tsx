import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useI18n } from "@/lib/i18n-context";
import {
  type ReviewBlockedMessageKey,
  workflowReviewBlockedKey,
  workflowReviewFailure,
  workflowReviewStorageKey,
} from "@/lib/workflow-review";
import {
  WorkflowReviewDialog,
  type WorkflowReviewDisplay,
  type WorkflowReviewState,
} from "./workflow-review-dialog";

type Receipt = components["schemas"]["WorkflowReviewReceipt"];
type Actions = Receipt["actions"];
type Policies = components["schemas"]["ToolPoliciesResponse"];
const saveActions: Actions = { activate: false, grant: null, schedule: null };

export function WorkflowReview({
  conversationId,
  elicitationId,
  open,
  onOpenChange,
}: {
  conversationId: string;
  elicitationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [selectedActions, setSelectedActions] = useState<Actions>(saveActions);
  const [state, setState] = useState<WorkflowReviewState>("preparing");
  const [message, setMessage] = useState<string>();
  const [blockedKey, setBlockedKey] = useState<ReviewBlockedMessageKey | null>(null);
  const [remember, setRemember] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyAvailable, setPolicyAvailable] = useState(false);
  const generation = useRef(0);
  const initialized = useRef(false);
  const finalizing = useRef(false);
  const storageKey = workflowReviewStorageKey(conversationId, elicitationId);
  const path = `/v1/conversations/${encodeURIComponent(conversationId)}/workflow-reviews`;
  const policyPath = `/v1/conversations/${encodeURIComponent(conversationId)}/tool-policies`;
  const store = useCallback(
    (id: string | null) => {
      try {
        if (id) sessionStorage.setItem(storageKey, id);
        else sessionStorage.removeItem(storageKey);
      } catch {}
    },
    [storageKey],
  );
  const accept = useCallback(
    (value: Receipt) => {
      setReceipt(value);
      setSelectedActions(value.actions);
      setMessage(undefined);
      if (value.status === "completed") {
        store(null);
        setState("completed");
      } else {
        store(value.receipt_id);
        setState(Date.parse(value.expires_at) <= Date.now() ? "expired" : "ready");
      }
    },
    [store],
  );
  const prepare = useCallback(
    async (actions: Actions = saveActions) => {
      if (finalizing.current) return;
      const current = ++generation.current;
      setState("preparing");
      setMessage(undefined);
      try {
        const value = await apiRequest<Receipt>(
          path,
          { method: "POST", body: JSON.stringify({ elicitation_id: elicitationId, ...actions }) },
          { timeoutMs: 30_000 },
        );
        if (current === generation.current) accept(value);
      } catch (error) {
        if (current !== generation.current) return;
        const failure = workflowReviewFailure(error, false);
        setState(failure);
        if (failure === "blocked" && error instanceof ApiError) {
          setMessage(error.message);
          setBlockedKey(workflowReviewBlockedKey(error));
        }
      }
    },
    [accept, elicitationId, path],
  );
  const checkResult = useCallback(
    async (receiptId: string) => {
      if (finalizing.current) return;
      setState("preparing");
      try {
        const value = await apiRequest<Receipt>(
          `${path}/${encodeURIComponent(receiptId)}`,
          {},
          { timeoutMs: 15_000 },
        );
        accept(value);
      } catch (error) {
        const failure = workflowReviewFailure(error, true);
        setState(failure === "failed" ? "uncertain" : failure);
      }
    },
    [accept, path],
  );
  useEffect(() => {
    if (!open || initialized.current) return;
    initialized.current = true;
    let previous: string | null = null;
    try {
      previous = sessionStorage.getItem(storageKey);
    } catch {}
    if (previous) void checkResult(previous);
    else void prepare();
    void apiRequest<Policies>(policyPath)
      .then((value) => {
        setRemember(value.policies.save_workflow_draft === "no_confirm");
        setPolicyAvailable(value.eligible_no_confirm_tools.includes("save_workflow_draft"));
      })
      .catch(() => setMessage(t("reviewWorkflow.policyLoadFailed")));
  }, [checkResult, open, policyPath, prepare, storageKey, t]);
  useEffect(() => {
    if (state !== "ready" || !receipt) return;
    const delay = Math.max(0, Date.parse(receipt.expires_at) - Date.now());
    const timer = window.setTimeout(() => setState("expired"), delay);
    return () => window.clearTimeout(timer);
  }, [receipt, state]);
  const refreshConversation = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] }),
      queryClient.invalidateQueries({ queryKey: ["conversations"] }),
      queryClient.invalidateQueries({ queryKey: ["decisions"] }),
      queryClient.invalidateQueries({ queryKey: ["attention"] }),
      queryClient.invalidateQueries({ queryKey: ["workflows"] }),
    ]);
  };
  const complete = async (saveOnly: boolean) => {
    if (!receipt || state !== "ready" || policyBusy || finalizing.current) return;
    finalizing.current = true;
    setState("completing");
    setMessage(undefined);
    try {
      const result = await apiRequest<Receipt>(
        `${path}/${encodeURIComponent(receipt.receipt_id)}/finalize`,
        {
          method: "POST",
          body: JSON.stringify({
            expected_snapshot_digest: receipt.snapshot_digest,
            ...(saveOnly ? { save_only: true } : {}),
          }),
        },
        { timeoutMs: 30_000 },
      );
      accept(result);
    } catch (error) {
      const failure = workflowReviewFailure(error, true);
      setState(failure);
      if (failure === "blocked" && error instanceof ApiError) {
        setMessage(error.message);
        setBlockedKey(workflowReviewBlockedKey(error));
      }
    } finally {
      finalizing.current = false;
    }
  };
  const changePolicy = async (checked: boolean) => {
    if (policyBusy || !policyAvailable || state !== "ready") return;
    setPolicyBusy(true);
    setMessage(undefined);
    try {
      const value = await apiRequest<Policies>(
        policyPath,
        {
          method: "PUT",
          body: JSON.stringify({
            policies: { save_workflow_draft: checked ? "no_confirm" : null },
          }),
        },
        { timeoutMs: 15_000 },
      );
      setRemember(value.policies.save_workflow_draft === "no_confirm");
    } catch {
      try {
        const value = await apiRequest<Policies>(policyPath, {}, { timeoutMs: 15_000 });
        setRemember(value.policies.save_workflow_draft === "no_confirm");
        setPolicyAvailable(value.eligible_no_confirm_tools.includes("save_workflow_draft"));
      } catch {
        setPolicyAvailable(false);
      }
      setMessage(t("reviewWorkflow.policyFailed"));
    } finally {
      setPolicyBusy(false);
    }
  };
  const suggestions = receipt?.suggested_actions;
  const grant = receipt?.actions.grant ?? suggestions?.grant;
  const review: WorkflowReviewDisplay | null = receipt
    ? {
        workflow_name: receipt.workflow_name,
        workflow_slug: receipt.workflow_slug,
        reviewed_version_label:
          receipt.reviewed_version_number === null
            ? t("reviewWorkflow.newVersion")
            : t("reviewWorkflow.version", { number: String(receipt.reviewed_version_number) }),
        description: receipt.description,
        checks: receipt.checks,
        environment: t(
          (receipt.environment ?? grant?.environment) === "prod"
            ? "run.environment.prod"
            : "run.environment.dev",
        ),
        effects: receipt.effects.map((effect) => ({
          ...effect,
          connector_name: effect.connector_name ?? "",
          connector_slug: effect.connector_slug ?? "",
          effect: t(
            effect.effect === "read"
              ? "reviewWorkflow.read"
              : effect.effect === "write"
                ? "reviewWorkflow.write"
                : "reviewWorkflow.unknown",
          ),
          target: effect.target ?? t("reviewWorkflow.unknownTarget"),
        })),
        affected_triggers: receipt.affected_triggers.map((trigger, index) => ({
          ...trigger,
          id: `${trigger.kind}-${index}`,
        })),
        grant:
          grant?.max_runs && grant.valid_until
            ? { max_runs: grant.max_runs, valid_until: grant.valid_until }
            : null,
        schedule: receipt.actions.schedule ?? suggestions?.schedule ?? null,
      }
    : null;
  return (
    <WorkflowReviewDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next && state === "completed") void refreshConversation();
      }}
      review={review}
      state={state}
      message={blockedKey ? t(blockedKey) : message}
      grantSelected={
        receipt?.status === "completed"
          ? receipt.result?.granted === true
          : selectedActions.activate
      }
      scheduleSelected={
        receipt?.status === "completed"
          ? receipt.result?.schedule_id != null
          : selectedActions.schedule != null
      }
      remember={remember}
      policyBusy={policyBusy}
      policyAvailable={policyAvailable}
      onGrantChange={(checked) => {
        const actions = {
          ...selectedActions,
          activate: checked,
          grant: checked ? (grant ?? null) : null,
        };
        setSelectedActions(actions);
        if (!actions.schedule || actions.activate) void prepare(actions);
      }}
      onScheduleChange={(checked) => {
        const actions = {
          ...selectedActions,
          schedule: checked ? (suggestions?.schedule ?? null) : null,
        };
        setSelectedActions(actions);
        if (!actions.schedule || actions.activate) void prepare(actions);
      }}
      onRememberChange={(checked) => void changePolicy(checked)}
      onComplete={(saveOnly) => void complete(saveOnly)}
      onRefresh={() => void prepare()}
      onCheckResult={() => {
        if (receipt) void checkResult(receipt.receipt_id);
        else {
          try {
            const id = sessionStorage.getItem(storageKey);
            if (id) void checkResult(id);
          } catch {}
        }
      }}
    />
  );
}
