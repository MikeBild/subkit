import type { useQueryClient } from "@tanstack/react-query";
export const CATEGORIES_KEY = ["intake", "categories"] as const;
export const DEFAULT_CATEGORY_KEY = ["intake", "default-category"] as const;
export const CLIPS_KEY = ["intake", "clips"] as const;

export function invalidateIntake(queryClient: ReturnType<typeof useQueryClient>): Promise<unknown> {
  return queryClient.invalidateQueries({ queryKey: ["intake"] });
}
