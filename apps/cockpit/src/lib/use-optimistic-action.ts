import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n-context";

// A quick action (approve, revoke, enable, rename) shows its result at once:
// the cached read is changed before the request leaves, put back exactly as it
// was if the engine refuses, and read again either way so the screen ends on
// what the engine holds. A refusal says so in one toast.

export interface OptimisticAction<TVars, TResult, TData> {
  /** The read the action changes. */
  queryKey: QueryKey;
  mutationFn(vars: TVars): Promise<TResult>;
  /** The read as it will be once the action succeeds. */
  apply(current: TData | undefined, vars: TVars): TData | undefined;
  /** Further reads the action changes, refreshed when it settles. */
  invalidate?: readonly QueryKey[];
  /** The refusal's toast; defaults to "the change was undone". */
  errorMessage?: (error: unknown) => string;
  onSuccess?(result: TResult, vars: TVars): void;
}

export function useOptimisticAction<TVars, TResult, TData>(
  action: OptimisticAction<TVars, TResult, TData>,
) {
  const client = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: action.mutationFn,
    onMutate: async (vars: TVars) => {
      await client.cancelQueries({ queryKey: action.queryKey });
      const previous = client.getQueryData<TData>(action.queryKey);
      client.setQueryData<TData | undefined>(action.queryKey, (current) =>
        action.apply(current, vars),
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      client.setQueryData(action.queryKey, context?.previous);
      toast.error(action.errorMessage?.(error) ?? t("platform.actionFailed"));
    },
    onSuccess: (result, vars) => action.onSuccess?.(result, vars),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: action.queryKey });
      for (const queryKey of action.invalidate ?? []) void client.invalidateQueries({ queryKey });
    },
  });
}
