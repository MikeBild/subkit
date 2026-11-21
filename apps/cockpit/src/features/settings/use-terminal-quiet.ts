import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import type { TerminalQuiet } from "./notifications-model";

const START = "notifications.push.quietHoursStart";
const END = "notifications.push.quietHoursEnd";

async function read(path: string, tenant: string): Promise<string> {
  const entry = await apiCall("get", "/v1/settings/{path}", { path: { path }, query: { tenant } });
  return typeof entry.value === "string" ? entry.value : "";
}

async function write(path: string, tenant: string, value: string): Promise<void> {
  await apiCall("put", "/v1/settings/{path}", {
    path: { path },
    query: { tenant },
    body: { value },
  });
}

export function useTerminalQuiet(tenant: string, enabled: boolean) {
  const client = useQueryClient();
  const key = ["terminal-quiet", tenant] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<TerminalQuiet> => ({
      from: await read(START, tenant),
      until: await read(END, tenant),
    }),
    enabled,
    retry: false,
  });
  const save = useMutation({
    mutationFn: async (value: TerminalQuiet) => {
      await write(START, tenant, value.from);
      await write(END, tenant, value.until);
      return value;
    },
    onSuccess: (value) => client.setQueryData(key, value),
  });
  return {
    value: query.data ?? null,
    save: (value: TerminalQuiet) => save.mutate(value),
    retry: () => save.variables && save.mutate(save.variables),
    saving: save.isPending,
    saveError: save.isError ? save.error : null,
  };
}
