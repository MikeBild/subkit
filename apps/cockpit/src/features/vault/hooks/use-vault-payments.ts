import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  approvePayment,
  importVaultCsv,
  listPendingPayments,
  rejectPayment,
  resumePaymentStep,
  VAULT_PAYMENTS_KEY,
} from "@/api/vault";
import {
  approvalMutation,
  type DecisionPorts,
  decidePayment,
  type PendingResume,
} from "@/features/vault/model/payments";

export function usePendingPayments(enabled = true) {
  return useQuery({ queryKey: VAULT_PAYMENTS_KEY, queryFn: listPendingPayments, enabled });
}

function useDecisionPorts(): DecisionPorts {
  const client = useQueryClient();
  return {
    approve: approvePayment,
    reject: rejectPayment,
    resume: async (resume, confirmed) => {
      const step = await resumePaymentStep(resume, confirmed);
      const refresh = () => {
        void client.invalidateQueries({ queryKey: ["conversation", resume.conversation_id] });
        void client.invalidateQueries({ queryKey: ["conversations"] });
      };
      refresh();
      step.finished.then(refresh, refresh);
    },
  };
}

export function useApprovePayment() {
  const ports = useDecisionPorts();
  return useMutation(
    approvalMutation((id, cvv) => decidePayment(ports, { kind: "approve", id, cvv })),
  );
}

export function useRejectPayment() {
  const ports = useDecisionPorts();
  return useMutation({
    mutationFn: (id: string) => decidePayment(ports, { kind: "reject", id }),
    retry: false,
  });
}

export function useResumeChat() {
  const ports = useDecisionPorts();
  return useMutation({
    mutationFn: (pending: PendingResume) => ports.resume(pending.resume, pending.confirmed),
    retry: false,
  });
}

export function useVaultImport() {
  return useMutation({
    mutationFn: importVaultCsv,
    gcTime: 0,
    retry: false,
    meta: { sensitive: true },
  });
}
