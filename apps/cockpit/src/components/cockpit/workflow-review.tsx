import type { components } from "@cli-core/engine-api/openapi";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import {
  DEFAULT_GRANT_LIMIT,
  type GrantLimit,
  grantLimitOf,
  reviewGrantAction,
} from "@/lib/core/authority-decision";
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
const saveActions: Actions = { activate: false, grant: null, schedule: null };
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
  const [limit, setLimit] = useState<GrantLimit>(DEFAULT_GRANT_LIMIT);
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
      if (value.actions.grant) setLimit(grantLimitOf(value.actions.grant));
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
        const value = await apiCall("post", "/v1/conversations/{id}/workflow-reviews", {
          path: { id: conversationId },
          body: { elicitation_id: elicitationId, ...actions },
          limits: { timeoutMs: 30_000 },
        });
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
    [accept, elicitationId, conversationId],
  );
  const checkResult = useCallback(
    async (receiptId: string) => {
      if (finalizing.current) return;
      setState("preparing");
      try {
        const value = await apiCall("get", "/v1/conversations/{id}/workflow-reviews/{receipt_id}", {
          path: { id: conversationId, receipt_id: receiptId },
          limits: { timeoutMs: 15_000 },
        });
        accept(value);
      } catch (error) {
        const failure = workflowReviewFailure(error, true);
        setState(failure === "failed" ? "uncertain" : failure);
      }
    },
    [accept, conversationId],
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
    void apiCall("get", "/v1/conversations/{id}/tool-policies", { path: { id: conversationId } })
      .then((value) => {
        setRemember(value.policies.save_workflow_draft === "no_confirm");
        setPolicyAvailable(value.eligible_no_confirm_tools.includes("save_workflow_draft"));
      })
      .catch(() => setMessage(t("reviewWorkflow.policyLoadFailed")));
  }, [checkResult, open, conversationId, prepare, storageKey, t]);
  useEffect(() => {
    if (state !== "ready" || !receipt) return;
    const expiresAt = Date.parse(receipt.expires_at);
    let timer: number;
    const arm = () => {
      const delay = Math.min(Math.max(0, expiresAt - Date.now()), MAX_TIMER_DELAY_MS);
      timer = window.setTimeout(
        () => (expiresAt <= Date.now() ? setState("expired") : arm()),
        delay,
      );
    };
    arm();
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
      const result = await apiCall(
        "post",
        "/v1/conversations/{id}/workflow-reviews/{receipt_id}/finalize",
        {
          path: { id: conversationId, receipt_id: receipt.receipt_id },
          body: {
            expected_snapshot_digest: receipt.snapshot_digest,
            ...(saveOnly ? { save_only: true } : {}),
          },
          limits: { timeoutMs: 30_000 },
        },
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
      const value = await apiCall("put", "/v1/conversations/{id}/tool-policies", {
        path: { id: conversationId },
        body: { policies: { save_workflow_draft: checked ? "no_confirm" : null } },
        limits: { timeoutMs: 15_000 },
      });
      setRemember(value.policies.save_workflow_draft === "no_confirm");
    } catch {
      try {
        const value = await apiCall("get", "/v1/conversations/{id}/tool-policies", {
          path: { id: conversationId },
          limits: { timeoutMs: 15_000 },
        });

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
  const grantFor = (next: GrantLimit) => (grant ? reviewGrantAction(grant, next) : null);
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
        grant: grant ? { limit } : null,
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
          grant: checked ? grantFor(limit) : null,
        };
        setSelectedActions(actions);
        if (!actions.schedule || actions.activate) void prepare(actions);
      }}
      onLimitChange={(next) => {
        setLimit(next);
        if (!selectedActions.activate) return;
        const actions = { ...selectedActions, grant: grantFor(next) };
        setSelectedActions(actions);
        void prepare(actions);
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
