import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SETUP_KEY, type Setup, useSetup, writeSetup } from "@/api/setup";

export function useSaveNotes(onFailed: (error: unknown) => void) {
  const client = useQueryClient();
  const setup = useSetup();
  const change = useMutation({
    mutationFn: (saveNewNotes: boolean) => writeSetup({ save_new_notes: saveNewNotes }),
    onSuccess: (stored: Setup) => client.setQueryData(SETUP_KEY, stored),
    onError: onFailed,
  });
  return {
    saveNewNotes: change.isPending ? change.variables : (setup.data?.save_new_notes ?? true),
    ready: setup.data !== undefined,
    saving: change.isPending,
    change: (saveNewNotes: boolean) => change.mutate(saveNewNotes),
  };
}
