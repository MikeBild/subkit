import type { MaterializedRequest } from "../../prepared-request.ts";

/** Provider-documented read operations that use POST. Evaluated only against
 * the final HTTP request, never an author's side_effects hint or connector name.
 * Google documents runReport with analytics.readonly scope:
 * https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
 */
export function isDocumentedReadOperation(request: MaterializedRequest | undefined): boolean {
  if (!request || request.method !== "POST" || request.unsupported_body) return false;
  try {
    const url = new URL(request.url);
    if (
      url.origin !== "https://analyticsdata.googleapis.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/v1beta\/properties\/[1-9][0-9]*:runReport$/.test(url.pathname) ||
      Object.keys(request.headers).some((key) =>
        /^(?:x-http-method(?:-override)?|x-method-override)$/i.test(key),
      )
    )
      return false;
    return (
      request.body !== null && typeof request.body === "object" && !Array.isArray(request.body)
    );
  } catch {
    return false;
  }
}
