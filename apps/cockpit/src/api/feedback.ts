import type { components } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";

export type SubmittedFeedback = components["schemas"]["SubmittedFeedback"];

export function submitFeedback(
  body: components["schemas"]["SubmitFeedbackBody"],
): Promise<SubmittedFeedback> {
  return apiCall("post", "/v1/feedback", { body });
}
