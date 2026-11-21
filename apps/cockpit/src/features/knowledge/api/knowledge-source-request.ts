import type { ApiRequestBody } from "@/api/call";
import {
  type RefreshRhythm,
  refreshFields,
} from "@/features/knowledge/model/knowledge-sources-model";

export function urlSourceBody(
  url: string,
  rhythm: Exclude<RefreshRhythm, "custom">,
): ApiRequestBody<"/v1/knowledge-sources/url", "post"> {
  const refresh = refreshFields(rhythm);
  return {
    url: url.trim(),
    refresh_strategy: refresh.refresh_strategy,
    ...(refresh.refresh_cron ? { refresh_cron: refresh.refresh_cron } : {}),
  };
}
