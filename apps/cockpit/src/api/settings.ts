import { apiCall } from "@/api/call";

export async function saveSetting(
  path: string,
  tenantId: string | null,
  value: unknown,
): Promise<void> {
  await apiCall("put", "/v1/settings/{path}", {
    path: { path },
    query: tenantId ? { tenant: tenantId } : {},
    body: { value },
  });
}
