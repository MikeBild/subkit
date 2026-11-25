import { useQuery } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import type { CatalogKind } from "../model/catalog-metadata-model";
import { catalogAICount } from "../model/catalog-origin-model";

/** How many catalog items of `kind` AI created; null while unknown or when loading failed. */
export function useCatalogAiCount(kind: CatalogKind): number | null {
  const query = useQuery({
    queryKey: ["catalog-categories"],
    queryFn: () => apiCall("get", "/v1/categories", {}),
  });
  return query.error ? null : catalogAICount(query.data?.categories, kind);
}
