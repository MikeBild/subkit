import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { APPROVAL_POLICY_KEY } from "@/api/approval-policy";
import { SETUP_KEY, type Setup, type SetupUpdate, useSetup, writeSetup } from "@/api/setup";
import { useSession } from "@/app/session";
import { usePairVisibility } from "@/features/operations";
import {
  answersFromSetup,
  questionUpdate,
  recommendedUpdate,
  type SetupAnswers,
  type SetupQuestionId,
  setupKeys,
  setupUpdate,
} from "./model/setup-model";

export type Invitation = NonNullable<Setup["invitation"]>;

function useStore() {
  const client = useQueryClient();
  return (stored: Setup): Invitation | null => {
    const { invitation, ...rest } = stored;
    client.setQueryData(SETUP_KEY, rest);
    void client.invalidateQueries({ queryKey: APPROVAL_POLICY_KEY });
    return invitation ?? null;
  };
}

export function usePairOption(stored: Pick<Setup, "approver"> | undefined): boolean {
  const readable = useSession().permissions.includes("workflow:read");
  return usePairVisibility(readable, stored?.approver.kind === "pair").option;
}

export function useSetupFlow(setup: Setup, events: { onDone(): void; onLater(): void }) {
  const store = useStore();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const save = useMutation({
    mutationFn: (body: SetupUpdate) => writeSetup(body),
    onSuccess: (stored) => {
      const prepared = store(stored);
      if (prepared) setInvitation(prepared);
      else events.onDone();
    },
  });
  const later = useMutation({
    mutationFn: () => writeSetup(recommendedUpdate(setup)),
    onSuccess: (stored) => {
      store(stored);
      events.onLater();
    },
  });
  return {
    setup: answersFromSetup(setup),
    invitation,
    applySetup: (answers: SetupAnswers) => {
      later.reset();
      save.mutate(setupUpdate(answers, setupKeys(setup)));
    },
    skip: () => {
      save.reset();
      later.mutate();
    },
    saving: save.isPending,
    skipping: later.isPending,
    saveError: save.isError ? save.error : null,
    skipError: later.isError ? later.error : null,
  };
}

export function useSetupSettings() {
  const store = useStore();
  const query = useSetup();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const save = useMutation({
    mutationFn: (body: SetupUpdate) => writeSetup(body),
    onSuccess: (stored) => setInvitation(store(stored)),
  });
  return {
    query,
    stored: query.data,
    setup: query.data ? answersFromSetup(query.data) : null,
    invitation,
    applyAnswer: (k: SetupQuestionId, answers: SetupAnswers, onSaved: () => void) =>
      save.mutate(questionUpdate(k, answers), { onSuccess: onSaved }),
    retry: save.variables ? () => save.variables && save.mutate(save.variables) : undefined,
    reset: save.reset,
    saving: save.isPending,
    saveError: save.isError ? save.error : null,
  };
}

export function useScheduleSave() {
  const store = useStore();
  const save = useMutation({
    mutationFn: (body: SetupUpdate) => writeSetup(body),
    onSuccess: (stored) => void store(stored),
  });
  return {
    save: (body: SetupUpdate) => save.mutate(body),
    retry: () => save.variables && save.mutate(save.variables),
    saving: save.isPending,
    saveError: save.isError ? save.error : null,
  };
}
