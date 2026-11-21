import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SETUP_KEY, type Setup, useSetup, writeSetup } from "@/api/setup";

export function useAskFirst(onFailed: (error: unknown) => void) {
  const client = useQueryClient();
  const setup = useSetup();
  const change = useMutation({
    mutationFn: (askFirst: boolean) => writeSetup({ ask_before_writing: askFirst }),
    onSuccess: (stored: Setup) => client.setQueryData(SETUP_KEY, stored),
    onError: onFailed,
  });
  return {
    askFirst: change.isPending ? change.variables : (setup.data?.ask_before_writing ?? false),
    ready: setup.data !== undefined,
    saving: change.isPending,
    change: (askFirst: boolean) => change.mutate(askFirst),
  };
}
