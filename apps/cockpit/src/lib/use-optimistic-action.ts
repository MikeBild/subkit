import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";

interface OptimisticAction<TVars, TResult, TData> {
  queryKey: QueryKey;
  mutationFn(vars: TVars): Promise<TResult>;
  apply(current: TData | undefined, vars: TVars): TData | undefined;
  fromResult?(result: TResult, vars: TVars): TData | undefined;
  invalidate?: readonly QueryKey[];
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
      reportFailure(action.errorMessage?.(error) ?? t("platform.actionFailed"), error);
    },
    onSuccess: (result, vars) => {
      const stated = action.fromResult?.(result, vars);
      if (stated !== undefined) client.setQueryData<TData>(action.queryKey, stated);
      action.onSuccess?.(result, vars);
    },
    onSettled: (result, error, vars) => {
      const answered = !error && action.fromResult?.(result as TResult, vars) !== undefined;
      if (!answered) void client.invalidateQueries({ queryKey: action.queryKey });
      for (const queryKey of action.invalidate ?? []) void client.invalidateQueries({ queryKey });
    },
  });
}
