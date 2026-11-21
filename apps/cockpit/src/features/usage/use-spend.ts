import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SETUP_KEY } from "@/api/setup";
import {
  continueSpend,
  readSpendLimit,
  SPEND_LIMIT_KEY,
  type SpendLimit,
  writeSpendLimit,
} from "@/api/spend-limit";

export function useSpend() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: SPEND_LIMIT_KEY, queryFn: readSpendLimit, retry: false });
  const store = (next: SpendLimit) => {
    client.setQueryData(SPEND_LIMIT_KEY, next);
    void client.invalidateQueries({ queryKey: ["attention"] });
    void client.invalidateQueries({ queryKey: SETUP_KEY });
  };
  const raise = useMutation({ mutationFn: writeSpendLimit, onSuccess: store });
  const keepGoing = useMutation({ mutationFn: continueSpend, onSuccess: store });
  return {
    spend: query.data,
    loading: query.isPending,
    failed: query.isError,
    retry: () => void query.refetch(),
    raise: (limit: number, onDone: () => void) => raise.mutate(limit, { onSuccess: onDone }),
    keepGoing: () => keepGoing.mutate(),
    saving: raise.isPending || keepGoing.isPending,
    saveError: raise.error ?? keepGoing.error ?? null,
  };
}
